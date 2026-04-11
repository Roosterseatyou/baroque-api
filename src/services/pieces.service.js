import db from "../config/knex.js";
import { generateUUID } from "../utils/uuid.js";
import * as dupQueue from "./dupQueue.service.js";

export async function createPiece({ libraryId, data }) {
  const pieceId = generateUUID();

  // normalize publisher to string: if an object passed, extract .name; otherwise store string or null
  let publisherValue = null;
  if (data.publisher) {
    if (typeof data.publisher === "string") publisherValue = data.publisher;
    else if (typeof data.publisher === "object" && data.publisher.name)
      publisherValue = data.publisher.name;
    else publisherValue = String(data.publisher);
  }

  // If collection_id provided, validate it belongs to the same library
  let collectionIdToStore = null;
  if (data.collection_id) {
    const col = await db("collections")
      .where({ id: data.collection_id })
      .first();
    if (!col) throw new Error("Invalid collection_id");
    if (String(col.library_id) !== String(libraryId))
      throw new Error("collection does not belong to library");
    collectionIdToStore = data.collection_id;
  }

  await db("pieces").insert({
    id: pieceId,
    library_id: libraryId,
    title: data.title,
    composer: data.composer,
    arranger: data.arranger || null,
    publisher: publisherValue,
    quantity: Number.isFinite(Number(data.quantity))
      ? Number(data.quantity)
      : 1,
    library_number: data.library_number || null,
    collection_id: collectionIdToStore,
    difficulty: data.difficulty || null,
    instrumentation: data.instrumentation || null,
    metadata: JSON.stringify(data.metadata || {}),
  });
  // return a normalized piece object including collection info when available
  return await getPieceById(pieceId);
}

export async function getPieceById(pieceId) {
  const piece = await db("pieces").where({ id: pieceId }).first();
  if (!piece) return null;
  piece.tags = await db("piece_tags")
    .join("tags", "piece_tags.tag_id", "tags.id")
    .where("piece_tags.piece_id", pieceId)
    .select("tags.id", "tags.name");
  // normalize quantity to number for API consumers
  piece.quantity = piece.quantity != null ? Number(piece.quantity) : 1;
  // include collection data when present
  if (piece.collection_id) {
    const col = await db("collections")
      .where({ id: piece.collection_id })
      .first();
    if (col)
      piece.collection = {
        id: col.id,
        name: col.name,
        library_number: col.library_number,
      };
    else piece.collection = null;
  } else {
    piece.collection = null;
  }
  return piece;
}

export async function getPieces(libraryId) {
  // Backwards-compatible: return all pieces when called without pagination
  const pieces = await db("pieces").where({ library_id: libraryId });
  const pieceIds = pieces.map((p) => p.id);
  if (pieceIds.length === 0) return [];
  const tagRows = await db("piece_tags")
    .join("tags", "piece_tags.tag_id", "tags.id")
    .whereIn("piece_tags.piece_id", pieceIds)
    .select(
      "piece_tags.piece_id as piece_id",
      "tags.id as id",
      "tags.name as name",
    );
  const tagsByPiece = {};
  for (const row of tagRows) {
    tagsByPiece[row.piece_id] = tagsByPiece[row.piece_id] || [];
    tagsByPiece[row.piece_id].push({ id: row.id, name: row.name });
  }
  // fetch collections referenced by these pieces
  const collectionIds = [
    ...new Set(pieces.map((p) => p.collection_id).filter(Boolean)),
  ];
  let collectionsById = {};
  if (collectionIds.length) {
    const cols = await db("collections")
      .whereIn("id", collectionIds)
      .select("id", "name", "library_number");
    for (const c of cols) collectionsById[c.id] = c;
  }
  return pieces.map((p) => ({
    ...p,
    tags: tagsByPiece[p.id] || [],
    quantity: p.quantity != null ? Number(p.quantity) : 1,
    collection: p.collection_id
      ? collectionsById[p.collection_id] || null
      : null,
  }));
}

// New: paginated fetch for pieces. Returns { pieces, total }
export async function getPiecesPaged(
  libraryId,
  {
    page = 1,
    perPage = 20,
    sortField = "title",
    sortDir = "asc",
    expanded = [],
  } = {},
) {
  const p = Math.max(1, Number(page) || 1);
  // enforce a maximum per-page to avoid very large responses / expensive queries
  const PIECES_MAX_PER_PAGE = Number(process.env.PIECES_MAX_PER_PAGE || 200);
  const ppRaw = Number(perPage) || 20;
  const pp = Math.max(1, Math.min(ppRaw, PIECES_MAX_PER_PAGE));

  // Whitelist allowed sort fields to avoid SQL errors or unintended column access
  const allowedSortFields = [
    "title",
    "composer",
    "library_number",
    "created_at",
    "instrumentation",
    "quantity",
  ];
  const defaultSort = "title";
  const sf = String(sortField || defaultSort).toLowerCase();
  const orderField = allowedSortFields.includes(sf) ? sf : defaultSort;
  const dir = String(sortDir || "asc").toLowerCase() === "desc" ? -1 : 1;

  // For correct interleaving / grouping we need to build an in-memory list of
  // collection rows and piece rows and then sort & paginate that list.
  // Note: this fetches minimal info for all pieces & collections in the library.
  // For very large libraries this may be expensive; if needed we can optimize
  // later by using DB-side union queries / keyset pagination.

  const cols = await db("collections")
    .where({ library_id: libraryId })
    .select("id", "name", "library_number", "metadata");
  const allPiecesRows = await db("pieces")
    .where({ library_id: libraryId })
    .select(
      "id",
      "title",
      "composer",
      "library_number",
      "collection_id",
      "instrumentation",
      "quantity",
      "difficulty",
      "arranger",
      "publisher",
      "metadata",
      "created_at",
    );

  // Build maps
  const piecesByCollection = {};
  for (const ppRow of allPiecesRows) {
    const cid = ppRow.collection_id || null;
    if (cid) {
      piecesByCollection[cid] = piecesByCollection[cid] || [];
      piecesByCollection[cid].push(ppRow);
    }
  }

  function normalizeForSort(val) {
    if (val === null || typeof val === "undefined") return "";
    return String(val);
  }

  function getSortKeyForCollection(c) {
    if (orderField === "title") return (c.name || "").toString().toLowerCase();
    if (orderField === "library_number") return String(c.library_number || "");
    // for other fields, attempt to take from metadata or name
    try {
      const meta =
        typeof c.metadata === "string"
          ? JSON.parse(c.metadata || "{}")
          : c.metadata || {};
      if (meta && meta[orderField] !== undefined)
        return String(meta[orderField]);
    } catch (e) {
      /* ignore */
    }
    return c.name || "";
  }
  function getSortKeyForPiece(p) {
    if (orderField === "title") return (p.title || "").toString().toLowerCase();
    if (orderField === "library_number") return String(p.library_number || "");
    if (p[orderField] !== undefined && p[orderField] !== null)
      return String(p[orderField]);
    return p.title || "";
  }

  // Normalize expanded collection IDs to strings for comparison
  const expandedSet = new Set((expanded || []).map((x) => String(x)));

  // Build rows depending on mode
  const rows = [];
  if (orderField === "library_number") {
    // Collections act as blocks: collection row followed by its pieces (sorted by same key)
    // First, ungrouped pieces
    const ungroupedPieces = allPiecesRows
      .filter((x) => !x.collection_id)
      .slice();
    // sort ungrouped pieces by library_number numeric-aware
    ungroupedPieces.sort((a, b) => {
      const aKey = getSortKeyForPiece(a);
      const bKey = getSortKeyForPiece(b);
      // numeric-aware comparison
      return (
        aKey.localeCompare(bKey, undefined, {
          numeric: true,
          sensitivity: "base",
        }) * dir
      );
    });

    // Build collection blocks
    const collectionBlocks = [];
    for (const c of cols) {
      const kids = (piecesByCollection[c.id] || []).slice();
      // sort children by same library_number ordering
      kids.sort((a, b) => {
        const ax = getSortKeyForPiece(a);
        const bx = getSortKeyForPiece(b);
        return (
          ax.localeCompare(bx, undefined, {
            numeric: true,
            sensitivity: "base",
          }) * dir
        );
      });
      collectionBlocks.push({ collection: c, children: kids });
    }

    // Sort collection blocks by collection library_number numeric-aware
    collectionBlocks.sort((A, B) => {
      const aKey = getSortKeyForCollection(A.collection);
      const bKey = getSortKeyForCollection(B.collection);
      return (
        aKey.localeCompare(bKey, undefined, {
          numeric: true,
          sensitivity: "base",
        }) * dir
      );
    });

    // Merge: alternate collections blocks and ungrouped pieces into a single sequence by comparing keys
    let ci = 0,
      ui = 0;
    while (ci < collectionBlocks.length || ui < ungroupedPieces.length) {
      if (ci >= collectionBlocks.length) {
        // only ungrouped pieces remain
        const pRow = ungroupedPieces[ui++];
        rows.push({ __type: "piece", ...pRow, __fromCollection: false });
        continue;
      }
      if (ui >= ungroupedPieces.length) {
        // only collections remain
        const block = collectionBlocks[ci++];
        rows.push({
          __type: "collection",
          id: block.collection.id,
          name: block.collection.name,
          library_number: block.collection.library_number,
          metadata:
            typeof block.collection.metadata === "string"
              ? (() => {
                  try {
                    return JSON.parse(block.collection.metadata);
                  } catch (e) {
                    return null;
                  }
                })()
              : block.collection.metadata,
        });
        // If this collection is expanded (client requested), include children; otherwise only include the collection row
        if (expandedSet.has(String(block.collection.id))) {
          for (const kid of block.children)
            rows.push({ __type: "piece", ...kid, __fromCollection: true });
        }
        continue;
      }
      const nextCollectionKey = getSortKeyForCollection(
        collectionBlocks[ci].collection,
      );
      const nextUngroupedKey = getSortKeyForPiece(ungroupedPieces[ui]);
      const cmp = nextCollectionKey.localeCompare(nextUngroupedKey, undefined, {
        numeric: true,
        sensitivity: "base",
      });
      if (cmp * dir <= 0) {
        // collection comes first
        const block = collectionBlocks[ci++];
        rows.push({
          __type: "collection",
          id: block.collection.id,
          name: block.collection.name,
          library_number: block.collection.library_number,
          metadata:
            typeof block.collection.metadata === "string"
              ? (() => {
                  try {
                    return JSON.parse(block.collection.metadata);
                  } catch (e) {
                    return null;
                  }
                })()
              : block.collection.metadata,
        });
        if (expandedSet.has(String(block.collection.id))) {
          for (const kid of block.children)
            rows.push({ __type: "piece", ...kid, __fromCollection: true });
        }
      } else {
        const pRow = ungroupedPieces[ui++];
        rows.push({ __type: "piece", ...pRow, __fromCollection: false });
      }
    }
  } else {
    // Non-library_number sorts: do NOT emit collection header rows. Return
    // only piece rows so sorting and pagination operate directly on pieces.
    for (const pRow of allPiecesRows) {
      rows.push({
        __type: "piece",
        ...pRow,
        __fromCollection: !!pRow.collection_id,
      });
    }
    // Sort piece rows by piece key
    rows.sort((a, b) => {
      const aKey = getSortKeyForPiece(a);
      const bKey = getSortKeyForPiece(b);
      return (
        String(aKey || "").localeCompare(String(bKey || ""), undefined, {
          numeric: true,
          sensitivity: "base",
        }) * dir
      );
    });
  }

  const totalRows = rows.length;
  const start = (p - 1) * pp;
  let pageSlice = rows.slice(start, start + pp);

  // Instead of inserting placeholder rows (which would change pagination boundaries
  // and can cause duplication/shift), attach metadata to piece rows indicating
  // that their collection header lives on a previous page. The client can render
  // a small continued header when it sees this flag without the server changing
  // the row indices.
  for (const item of pageSlice) {
    if (
      item.__type === "piece" &&
      item.__fromCollection &&
      item.collection_id
    ) {
      const cid = item.collection_id;
      const canonicalIndex = rows.findIndex(
        (r) => r.__type === "collection" && r.id === cid,
      );
      if (canonicalIndex !== -1) {
        // If the canonical header is before this page's start, mark as continued
        if (canonicalIndex < start) {
          const colObj = cols.find((c) => c.id === cid) || null;
          item.collection_continued = true;
          item.collection = colObj
            ? {
                id: colObj.id,
                name: colObj.name,
                library_number: colObj.library_number,
                metadata:
                  typeof colObj.metadata === "string"
                    ? (() => {
                        try {
                          return JSON.parse(colObj.metadata);
                        } catch (e) {
                          return null;
                        }
                      })()
                    : colObj.metadata,
              }
            : null;
        } else {
          // If header is on this page, optionally attach collection info for client convenience
          const colObj = cols.find((c) => c.id === cid) || null;
          item.collection = colObj
            ? {
                id: colObj.id,
                name: colObj.name,
                library_number: colObj.library_number,
                metadata:
                  typeof colObj.metadata === "string"
                    ? (() => {
                        try {
                          return JSON.parse(colObj.metadata);
                        } catch (e) {
                          return null;
                        }
                      })()
                    : colObj.metadata,
              }
            : null;
          item.collection_continued = false;
        }
      }
    }
  }

  // For piece rows in final page, fetch tags
  const pieceIdsInSlice = pageSlice
    .filter((r) => r.__type === "piece")
    .map((r) => r.id);
  let tagsByPiece = {};
  if (pieceIdsInSlice.length) {
    const tagRows = await db("piece_tags")
      .join("tags", "piece_tags.tag_id", "tags.id")
      .whereIn("piece_tags.piece_id", pieceIdsInSlice)
      .select(
        "piece_tags.piece_id as piece_id",
        "tags.id as id",
        "tags.name as name",
      );
    for (const tr of tagRows) {
      tagsByPiece[tr.piece_id] = tagsByPiece[tr.piece_id] || [];
      tagsByPiece[tr.piece_id].push({ id: tr.id, name: tr.name });
    }
  }

  // Attach tags and normalize quantities for piece rows
  for (const r of pageSlice) {
    if (r.__type === "piece") {
      r.tags = tagsByPiece[r.id] || [];
      r.quantity = r.quantity != null ? Number(r.quantity) : 1;
    }
  }

  const parsedCollections = cols.map((c) => ({
    id: c.id,
    name: c.name,
    library_number: c.library_number,
    metadata:
      typeof c.metadata === "string"
        ? (() => {
            try {
              return JSON.parse(c.metadata);
            } catch (e) {
              return null;
            }
          })()
        : c.metadata,
  }));
  return {
    pieces: pageSlice,
    total: totalRows,
    collections: parsedCollections,
  };
}

export async function updatePiece(pieceId, data) {
  // normalize publisher to string for varchar column
  let publisherValue = null;
  if (data.publisher) {
    if (typeof data.publisher === "string") publisherValue = data.publisher;
    else if (typeof data.publisher === "object" && data.publisher.name)
      publisherValue = data.publisher.name;
    else publisherValue = String(data.publisher);
  }

  // Validate collection_id if provided, and build update object conditionally
  const existing = await db("pieces").where({ id: pieceId }).first();
  if (!existing) throw new Error("Piece not found");

  const update = {
    title: data.title,
    composer: data.composer,
    arranger: data.arranger || null,
    publisher: publisherValue,
    quantity: Number.isFinite(Number(data.quantity))
      ? Number(data.quantity)
      : 1,
    library_number: data.library_number || null,
    difficulty: data.difficulty || null,
    instrumentation: data.instrumentation || null,
    metadata: JSON.stringify(data.metadata || {}),
    updated_at: db.fn.now(),
  };

  if (typeof data.collection_id !== "undefined") {
    if (data.collection_id === null) {
      update.collection_id = null;
    } else {
      const col = await db("collections")
        .where({ id: data.collection_id })
        .first();
      if (!col) throw new Error("Invalid collection_id");
      if (String(col.library_id) !== String(existing.library_id))
        throw new Error("collection does not belong to piece library");
      update.collection_id = data.collection_id;
    }
  }

  await db("pieces").where({ id: pieceId }).update(update);
  return await getPieceById(pieceId);
}

export async function deletePiece(pieceId) {
  await db("pieces").where({ id: pieceId }).del();
}

export async function searchPieces(libraryId, query, opts = {}) {
  const q = (query || "").trim();
  const byTitle = !!opts.byTitle;
  const byComposer = !!opts.byComposer;
  const byLibNumber = !!opts.byLibNumber;

  const piecesQuery = db("pieces").where({ library_id: libraryId });

  if (!q) {
    // empty query -> return all pieces for the library
    const allPieces = await piecesQuery;
    const allIds = allPieces.map((p) => p.id);
    if (allIds.length === 0) return [];
    const tagRows = await db("piece_tags")
      .join("tags", "piece_tags.tag_id", "tags.id")
      .whereIn("piece_tags.piece_id", allIds)
      .select(
        "piece_tags.piece_id as piece_id",
        "tags.id as id",
        "tags.name as name",
      );
    const tagsByPiece = {};
    for (const row of tagRows) {
      tagsByPiece[row.piece_id] = tagsByPiece[row.piece_id] || [];
      tagsByPiece[row.piece_id].push({ id: row.id, name: row.name });
    }
    return allPieces.map((p) => ({
      ...p,
      tags: tagsByPiece[p.id] || [],
      quantity: p.quantity != null ? Number(p.quantity) : 1,
    }));
  }

  const like = `%${q}%`;
  piecesQuery.andWhere(function () {
    // if no specific field selected, default to title OR composer
    if (!byTitle && !byComposer && !byLibNumber) {
      this.where("title", "like", like).orWhere("composer", "like", like);
      return;
    }
    // otherwise, OR together the selected fields
    if (byTitle) this.orWhere("title", "like", like);
    if (byComposer) this.orWhere("composer", "like", like);
    if (byLibNumber) this.orWhere("library_number", "like", like);
  });

  const pieces = await piecesQuery;
  const pieceIds = pieces.map((p) => p.id);
  if (pieceIds.length === 0) return [];
  const tagRows = await db("piece_tags")
    .join("tags", "piece_tags.tag_id", "tags.id")
    .whereIn("piece_tags.piece_id", pieceIds)
    .select(
      "piece_tags.piece_id as piece_id",
      "tags.id as id",
      "tags.name as name",
    );
  const tagsByPiece = {};
  for (const row of tagRows) {
    tagsByPiece[row.piece_id] = tagsByPiece[row.piece_id] || [];
    tagsByPiece[row.piece_id].push({ id: row.id, name: row.name });
  }
  return pieces.map((p) => ({
    ...p,
    tags: tagsByPiece[p.id] || [],
    quantity: p.quantity != null ? Number(p.quantity) : 1,
  }));
}

export async function findPieceByTitleAndComposer(libraryId, title, composer) {
  if (!title) return null;
  const q = db("pieces").where({ library_id: libraryId });
  q.andWhere("title", String(title));
  if (composer) q.andWhere("composer", String(composer));
  const piece = await q.first();
  return piece || null;
}

// Search pieces across other libraries in the same organization (used for autofill suggestions)
export async function searchPiecesInOrgLibraries({
  libraryId,
  orgId,
  query,
  maxResults = 10,
  includeExternal = false,
}) {
  // If includeExternal is false we require orgId; otherwise includeExternal will search across orgs
  if (!includeExternal && !orgId) return [];

  // Build merged rows (collections as blocks and pieces as rows) server-side
  // so pagination and sorting treat collection rows as first-class entries.
  const allowedSortFields = [
    "title",
    "composer",
    "library_number",
    "created_at",
    "instrumentation",
    "quantity",
  ];
  const defaultSort = "title";
  const sf = String(sortField || defaultSort).toLowerCase();
  const orderField = allowedSortFields.includes(sf) ? sf : defaultSort;
  const dir = String(sortDir || "asc").toLowerCase() === "desc" ? -1 : 1;

  // Fetch collections and pieces (minimal fields) for merging
  const cols = await db("collections")
    .where({ library_id: libraryId })
    .select("id", "name", "library_number", "metadata");
  const allPieces = await db("pieces")
    .where({ library_id: libraryId })
    .select(
      "id",
      "title",
      "composer",
      "library_number",
      "collection_id",
      "instrumentation",
      "quantity",
      "difficulty",
      "arranger",
      "publisher",
      "metadata",
    );

  // Map pieces by collection
  const piecesByCollection = {};
  for (const pp of allPieces) {
    const cid = pp.collection_id || null;
    if (cid) {
      piecesByCollection[cid] = piecesByCollection[cid] || [];
      piecesByCollection[cid].push(pp);
    }
  }

  // Helper to produce sort keys
  function getSortKeyForCollection(c) {
    if (orderField === "title") return (c.name || "").toString().toLowerCase();
    if (orderField === "library_number") return String(c.library_number || "");
    return (c.metadata && c.metadata[orderField]) || c.name || "";
  }
  function getSortKeyForPiece(p) {
    if (orderField === "title") return (p.title || "").toString().toLowerCase();
    if (orderField === "library_number") return String(p.library_number || "");
    return p[orderField] !== undefined && p[orderField] !== null
      ? String(p[orderField])
      : p.title || "";
  }

  // Build blocks: collection blocks and ungrouped pieces
  const blocks = [];
  for (const c of cols) {
    const key = getSortKeyForCollection(c);
    blocks.push({ type: "collection", key, collection: c });
  }
  for (const p of allPieces.filter((x) => !x.collection_id)) {
    const key = getSortKeyForPiece(p);
    blocks.push({ type: "piece", key, piece: p });
  }

  // Sort blocks
  blocks.sort((a, b) => {
    const aVal = a.key || "";
    const bVal = b.key || "";
    // numeric-aware localeCompare to handle numbers gracefully
    const cmp = aVal.localeCompare(bVal, undefined, {
      numeric: true,
      sensitivity: "base",
    });
    return dir * cmp;
  });

  // Flatten blocks into rows (collections with their children)
  const rows = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (b.type === "collection") {
      const c = b.collection;
      rows.push({
        __type: "collection",
        id: c.id,
        name: c.name,
        library_number: c.library_number,
        metadata:
          typeof c.metadata === "string"
            ? (() => {
                try {
                  return JSON.parse(c.metadata);
                } catch (e) {
                  return null;
                }
              })()
            : c.metadata,
      });
      // add children immediately after collection
      const kids = (piecesByCollection[c.id] || []).slice();
      // sort children by same orderField
      kids.sort((x, y) => {
        const ax = getSortKeyForPiece(x);
        const bx = getSortKeyForPiece(y);
        return (
          dir *
          String(ax).localeCompare(String(bx), undefined, {
            numeric: true,
            sensitivity: "base",
          })
        );
      });
      for (const k of kids)
        rows.push({ __type: "piece", ...k, __fromCollection: true });
    } else {
      rows.push({ __type: "piece", ...b.piece, __fromCollection: false });
    }
  }

  const totalRows = rows.length;
  const start = (p - 1) * pp;
  const pageSlice = rows.slice(start, start + pp);

  // For piece rows in slice, fetch tags
  const pieceIdsInSlice = pageSlice
    .filter((r) => r.__type === "piece")
    .map((r) => r.id);
  let tagsByPiece = {};
  if (pieceIdsInSlice.length) {
    const tagRows = await db("piece_tags")
      .join("tags", "piece_tags.tag_id", "tags.id")
      .whereIn("piece_tags.piece_id", pieceIdsInSlice)
      .select(
        "piece_tags.piece_id as piece_id",
        "tags.id as id",
        "tags.name as name",
      );
    for (const tr of tagRows) {
      tagsByPiece[tr.piece_id] = tagsByPiece[tr.piece_id] || [];
      tagsByPiece[tr.piece_id].push({ id: tr.id, name: tr.name });
    }
  }

  // Attach tags and normalize quantities for piece rows
  for (const r of pageSlice) {
    if (r.__type === "piece") {
      r.tags = tagsByPiece[r.id] || [];
      r.quantity = r.quantity != null ? Number(r.quantity) : 1;
    }
  }

  return { pieces: pageSlice, total: totalRows };

  // helper: compute Levenshtein distance between two strings
  function levenshtein(a, b) {
    const m = a.length,
      n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const v0 = new Array(n + 1),
      v1 = new Array(n + 1);
    for (let j = 0; j <= n; j++) v0[j] = j;
    for (let i = 0; i < m; i++) {
      v1[0] = i + 1;
      for (let j = 0; j < n; j++) {
        const cost = a[i] === b[j] ? 0 : 1;
        v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
      }
      for (let j = 0; j <= n; j++) v0[j] = v1[j];
    }
    return v1[n];
  }

  // helper: normalize strings for comparison (strip diacritics/punctuation, collapse spaces, lowercase)
  function normalize(s) {
    if (!s) return "";
    return String(s)
      .normalize("NFKD")
      .replace(/[ -\u036f]/g, "")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function similarity(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    const la = a.length,
      lb = b.length;
    const dist = levenshtein(a, b);
    const max = Math.max(la, lb);
    if (max === 0) return 1;
    return 1 - dist / max;
  }

  // Composer similarity: treat surnames as primary match (handles 'Dawson, W.L.' vs 'wdawson')
  function composerSimilar(aRaw, bRaw) {
    const aNorm = normalize(aRaw || "");
    const bNorm = normalize(bRaw || "");
    if (!aNorm || !bNorm) return false;

    // derive surname candidates from raw: if format 'Last, First' is used, take the part before comma
    function surnameFromRaw(raw, norm) {
      if (!raw) return "";
      if (raw.includes(",")) {
        const parts = raw.split(",");
        return normalize(parts[0] || "");
      }
      const tokens = norm.split(" ").filter(Boolean);
      return tokens.length ? tokens[tokens.length - 1] : "";
    }

    const aSurname = surnameFromRaw(aRaw, aNorm);
    const bSurname = surnameFromRaw(bRaw, bNorm);

    if (aSurname && bSurname && aSurname === bSurname) return true;
    // containment: one normalized string contains the other's surname (handles wdawson vs dawson)
    if (aNorm.includes(bSurname) || bNorm.includes(aSurname)) return true;
    // token intersection: any token matches
    const aTokens = aNorm.split(" ").filter(Boolean);
    const bTokens = bNorm.split(" ").filter(Boolean);
    for (const at of aTokens) {
      if (bTokens.includes(at)) return true;
    }
    // fallback to similarity on whole string
    return similarity(aNorm, bNorm) >= COMPOSER_SIM_THRESHOLD;
  }

  // thresholds (tunable)
  const TITLE_SIM_THRESHOLD = 0.78; // title similarity threshold for grouping
  const TITLE_STRICT_THRESHOLD = 0.9; // near-identical title for high severity
  const COMPOSER_SIM_THRESHOLD = 0.85; // composer similarity threshold

  // Build a list of normalized entries
  const items = rows.map((r) => ({
    raw: r,
    nkTitle: normalize(r.title || ""),
    nkComposer: normalize(r.composer || ""),
  }));

  const used = new Array(items.length).fill(false);
  const groups = [];

  // First: detect exact library_number conflicts (very-high severity)
  const libNumMap = {};
  items.forEach((it, idx) => {
    const num = (it.raw.library_number || "").toString().trim();
    if (!num) return;
    if (!libNumMap[num]) libNumMap[num] = [];
    libNumMap[num].push(idx);
  });
  for (const num of Object.keys(libNumMap)) {
    const idxs = libNumMap[num];
    if (idxs.length > 1) {
      const pieces = idxs.map((i) => items[i].raw);
      groups.push({
        titleKey: `libnum:${num}`,
        titleExample: `Library #${num}`,
        severity: "very-high",
        pieces,
      });
      // mark used so fuzzy scan won't re-include these
      for (const i of idxs) used[i] = true;
    }
  }

  // Fuzzy cluster remaining items by title AND composer similarity.
  // To avoid O(n^2) comparisons on very large libraries, first bucket items
  // by a prefix of their normalized title. Only items within the same bucket
  // are compared pairwise. This preserves matching quality while reducing
  // the total number of comparisons in typical datasets.
  const BUCKET_PREFIX_LEN = 10; // tuneable: number of chars from normalized title
  const bucketMap = new Map();
  for (let idx = 0; idx < items.length; idx++) {
    if (used[idx]) continue;
    const key = (items[idx].nkTitle || "").slice(0, BUCKET_PREFIX_LEN);
    if (!bucketMap.has(key)) bucketMap.set(key, []);
    bucketMap.get(key).push(idx);
  }

  for (const [prefix, idxs] of bucketMap.entries()) {
    // run clustering within this bucket
    for (let bi = 0; bi < idxs.length; bi++) {
      const i = idxs[bi];
      if (used[i]) continue;
      const base = items[i];
      const cluster = {
        titleKey: base.nkTitle,
        titleExample: base.raw.title || "",
        pieces: [base.raw],
      };
      used[i] = true;
      for (let bj = bi + 1; bj < idxs.length; bj++) {
        const j = idxs[bj];
        if (used[j]) continue;
        const other = items[j];
        const titleSim = similarity(base.nkTitle, other.nkTitle);
        const baseCompRaw = base.raw.composer || "";
        const otherCompRaw = other.raw.composer || "";

        // When both composers exist, prefer composer+title matching to avoid false positives.
        if (baseCompRaw && otherCompRaw) {
          const compSim = composerSimilar(baseCompRaw, otherCompRaw);
          if (titleSim >= TITLE_SIM_THRESHOLD && compSim) {
            cluster.pieces.push(other.raw);
            used[j] = true;
          }
        } else {
          // Fallback: strict title similarity only
          if (titleSim >= TITLE_STRICT_THRESHOLD) {
            cluster.pieces.push(other.raw);
            used[j] = true;
          }
        }
      }
      if (cluster.pieces.length > 1) groups.push(cluster);
    }
  }

  // compute severity for non-libnum groups
  const results = groups.map((g) => {
    if (g.severity === "very-high") return g;
    // compute composer similarity across pieces in the group
    const comps = g.pieces.map((p) => normalize(p.composer || ""));
    const nonEmpty = comps.filter((c) => c !== "");
    let severity = "medium";
    if (nonEmpty.length > 0) {
      const ref = nonEmpty[0];
      const allSimilar = nonEmpty.every((c) => {
        // surname equal or string similarity
        if (!c) return false;
        const surnameMatch = (() => {
          const aTokens = ref.split(" ").filter(Boolean);
          const bTokens = c.split(" ").filter(Boolean);
          return (
            aTokens.length &&
            bTokens.length &&
            aTokens[aTokens.length - 1] === bTokens[bTokens.length - 1]
          );
        })();
        return surnameMatch || similarity(ref, c) >= COMPOSER_SIM_THRESHOLD;
      });
      if (allSimilar) {
        // check title strictness for the group
        let minTitleSim = 1;
        for (let a = 0; a < g.pieces.length; a++)
          for (let b = a + 1; b < g.pieces.length; b++) {
            const ta = normalize(g.pieces[a].title || "");
            const tb = normalize(g.pieces[b].title || "");
            minTitleSim = Math.min(minTitleSim, similarity(ta, tb));
          }
        if (minTitleSim >= TITLE_STRICT_THRESHOLD) severity = "high";
        else severity = "medium";
      }
    }
    return {
      titleKey: g.titleKey,
      titleExample: g.titleExample,
      severity,
      pieces: g.pieces,
    };
  });

  // sort very-high then high then medium, then by title
  results.sort((a, b) => {
    const order = { "very-high": 0, high: 1, medium: 2 };
    const oa = order[a.severity] ?? 3;
    const ob = order[b.severity] ?? 3;
    if (oa !== ob) return oa - ob;
    return (a.titleExample || "").localeCompare(b.titleExample || "");
  });

  return results;
}

// Exported wrapper implementing duplicate detection for a full library.
export async function findDuplicatesInLibrary(libraryId) {
  if (!libraryId) return [];
  // Fetch pieces for analysis
  const rows = await db("pieces")
    .where({ library_id: libraryId })
    .select(
      "id",
      "title",
      "composer",
      "arranger",
      "publisher",
      "instrumentation",
      "library_number",
      "quantity",
      "difficulty",
      "metadata",
    );
  if (!rows || rows.length < 2) return [];

  // normalize helpers
  function levenshtein(a, b) {
    const m = a.length,
      n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const v0 = new Array(n + 1),
      v1 = new Array(n + 1);
    for (let j = 0; j <= n; j++) v0[j] = j;
    for (let i = 0; i < m; i++) {
      v1[0] = i + 1;
      for (let j = 0; j < n; j++) {
        const cost = a[i] === b[j] ? 0 : 1;
        v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
      }
      for (let j = 0; j <= n; j++) v0[j] = v1[j];
    }
    return v1[n];
  }
  function normalize(s) {
    if (!s) return "";
    return String(s)
      .normalize("NFKD")
      .replace(/[\u0000-\u036f]/g, "")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
  function similarity(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    const la = a.length,
      lb = b.length;
    const dist = levenshtein(a, b);
    const max = Math.max(la, lb);
    if (max === 0) return 1;
    return 1 - dist / max;
  }
  function composerSimilar(aRaw, bRaw) {
    const aNorm = normalize(aRaw || "");
    const bNorm = normalize(bRaw || "");
    if (!aNorm || !bNorm) return false;
    function surnameFromRaw(raw, norm) {
      if (!raw) return "";
      if (raw.includes(",")) return normalize(raw.split(",")[0] || "");
      const tokens = norm.split(" ").filter(Boolean);
      return tokens.length ? tokens[tokens.length - 1] : "";
    }
    const aSurname = surnameFromRaw(aRaw, aNorm);
    const bSurname = surnameFromRaw(bRaw, bNorm);
    if (aSurname && bSurname && aSurname === bSurname) return true;
    if (aNorm.includes(bSurname) || bNorm.includes(aSurname)) return true;
    const aTokens = aNorm.split(" ").filter(Boolean);
    const bTokens = bNorm.split(" ").filter(Boolean);
    for (const at of aTokens) if (bTokens.includes(at)) return true;
    return similarity(aNorm, bNorm) >= 0.85;
  }

  const TITLE_SIM_THRESHOLD = 0.78;
  const TITLE_STRICT_THRESHOLD = 0.9;

  const items = rows.map((r) => ({
    raw: r,
    nkTitle: normalize(r.title || ""),
    nkComposer: normalize(r.composer || ""),
  }));
  const used = new Array(items.length).fill(false);
  const groups = [];

  // exact lib number collisions
  const libNumMap = {};
  items.forEach((it, idx) => {
    const num = (it.raw.library_number || "").toString().trim();
    if (!num) return;
    if (!libNumMap[num]) libNumMap[num] = [];
    libNumMap[num].push(idx);
  });
  for (const num of Object.keys(libNumMap)) {
    const idxs = libNumMap[num];
    if (idxs.length > 1) {
      const pieces = idxs.map((i) => items[i].raw);
      groups.push({
        titleKey: `libnum:${num}`,
        titleExample: `Library #${num}`,
        severity: "very-high",
        pieces,
      });
      for (const i of idxs) used[i] = true;
    }
  }

  const BUCKET_PREFIX_LEN = 10;
  const bucketMap = new Map();
  for (let idx = 0; idx < items.length; idx++) {
    if (used[idx]) continue;
    const key = (items[idx].nkTitle || "").slice(0, BUCKET_PREFIX_LEN);
    if (!bucketMap.has(key)) bucketMap.set(key, []);
    bucketMap.get(key).push(idx);
  }

  for (const [prefix, idxs] of bucketMap.entries()) {
    for (let bi = 0; bi < idxs.length; bi++) {
      const i = idxs[bi];
      if (used[i]) continue;
      const base = items[i];
      const cluster = {
        titleKey: base.nkTitle,
        titleExample: base.raw.title || "",
        pieces: [base.raw],
      };
      used[i] = true;
      for (let bj = bi + 1; bj < idxs.length; bj++) {
        const j = idxs[bj];
        if (used[j]) continue;
        const other = items[j];
        const titleSim = similarity(base.nkTitle, other.nkTitle);
        const baseCompRaw = base.raw.composer || "";
        const otherCompRaw = other.raw.composer || "";
        if (baseCompRaw && otherCompRaw) {
          const compSim = composerSimilar(baseCompRaw, otherCompRaw);
          if (titleSim >= TITLE_SIM_THRESHOLD && compSim) {
            cluster.pieces.push(other.raw);
            used[j] = true;
          }
        } else {
          if (titleSim >= TITLE_STRICT_THRESHOLD) {
            cluster.pieces.push(other.raw);
            used[j] = true;
          }
        }
      }
      if (cluster.pieces.length > 1) groups.push(cluster);
    }
  }

  // compute severity
  const results = groups.map((g) => {
    if (g.severity === "very-high") return g;
    const comps = g.pieces.map((p) => normalize(p.composer || ""));
    const nonEmpty = comps.filter((c) => c !== "");
    let severity = "medium";
    if (nonEmpty.length > 0) {
      const ref = nonEmpty[0];
      const allSimilar = nonEmpty.every((c) => {
        if (!c) return false;
        const refTokens = ref.split(" ").filter(Boolean);
        const cTokens = c.split(" ").filter(Boolean);
        const surnameMatch =
          refTokens.length &&
          cTokens.length &&
          refTokens[refTokens.length - 1] === cTokens[cTokens.length - 1];
        return surnameMatch || similarity(ref, c) >= 0.85;
      });
      if (allSimilar) {
        let minTitleSim = 1;
        for (let a = 0; a < g.pieces.length; a++)
          for (let b = a + 1; b < g.pieces.length; b++) {
            const ta = normalize(g.pieces[a].title || "");
            const tb = normalize(g.pieces[b].title || "");
            minTitleSim = Math.min(minTitleSim, similarity(ta, tb));
          }
        if (minTitleSim >= TITLE_STRICT_THRESHOLD) severity = "high";
        else severity = "medium";
      }
    }
    return {
      titleKey: g.titleKey,
      titleExample: g.titleExample,
      severity,
      pieces: g.pieces,
    };
  });

  results.sort((a, b) => {
    const order = { "very-high": 0, high: 1, medium: 2 };
    const oa = order[a.severity] ?? 3;
    const ob = order[b.severity] ?? 3;
    if (oa !== ob) return oa - ob;
    return (a.titleExample || "").localeCompare(b.titleExample || "");
  });

  return results;
}

// In-memory cache for duplicate scan results
const _dupCache = new Map();
const DUP_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const DUP_ASYNC_THRESHOLD = 200; // libraries with more than this many pieces will be scanned in background

/**
 * Return cached duplicate scan results when available. For large libraries this will
 * trigger an asynchronous background scan and return the last cached result (or an
 * empty array) along with metadata.
 * Response shape: { groups: [...], cachedAt: <ms since epoch|null>, scanning: <bool> }
 */
export async function findDuplicatesInLibraryCached(libraryId) {
  if (!libraryId) return { groups: [], cachedAt: null, scanning: false };

  try {
    // Try to get latest job info (dupQueue will return parsed groups when available)
    const latest = await dupQueue.getLatestForLibrary(libraryId);
    if (latest && (latest.scanning || latest.cachedAt)) {
      return latest;
    }

    // No cached result exists; decide sync vs async by piece count
    const row = await db("pieces")
      .where({ library_id: libraryId })
      .count({ cnt: "*" })
      .first();
    const cnt = Number(row?.cnt || 0);
    if (cnt > DUP_ASYNC_THRESHOLD) {
      // large library: schedule an async scan and return scanning state
      await dupQueue.scheduleScan(libraryId);
      return { groups: [], cachedAt: null, scanning: true };
    }

    // small library: compute synchronously and persist a done job
    const groups = await findDuplicatesInLibrary(libraryId);
    try {
      await db("duplicate_scan_jobs").insert({
        library_id: libraryId,
        status: "done",
        result: JSON.stringify(groups),
        cached_at: Date.now(),
        attempts: 0,
        created_at: db.fn.now(),
        updated_at: db.fn.now(),
      });
    } catch (e) {
      // ignore DB insert errors but log
      console.warn("Failed to persist duplicate scan job result:", e);
    }
    return { groups, cachedAt: Date.now(), scanning: false };
  } catch (err) {
    console.error("findDuplicatesInLibraryCached error", err);
    return { groups: [], cachedAt: null, scanning: false };
  }
}
