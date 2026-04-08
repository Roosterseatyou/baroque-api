import db from '../config/knex.js';
import { generateUUID } from '../utils/uuid.js';
import * as dupQueue from './dupQueue.service.js';

export async function createPiece({ libraryId, data }) {
    const pieceId = generateUUID();

    // normalize publisher to string: if an object passed, extract .name; otherwise store string or null
    let publisherValue = null
    if (data.publisher) {
        if (typeof data.publisher === 'string') publisherValue = data.publisher
        else if (typeof data.publisher === 'object' && data.publisher.name) publisherValue = data.publisher.name
        else publisherValue = String(data.publisher)
    }

    // If collection_id provided, validate it belongs to the same library
    let collectionIdToStore = null;
    if (data.collection_id) {
        const col = await db('collections').where({ id: data.collection_id }).first();
        if (!col) throw new Error('Invalid collection_id');
        if (String(col.library_id) !== String(libraryId)) throw new Error('collection does not belong to library');
        collectionIdToStore = data.collection_id;
    }

    await db('pieces').insert({
        id: pieceId,
        library_id: libraryId,
        title: data.title,
        composer: data.composer,
        arranger: data.arranger || null,
        publisher: publisherValue,
        quantity: Number.isFinite(Number(data.quantity)) ? Number(data.quantity) : 1,
        library_number: data.library_number || null,
        collection_id: collectionIdToStore,
        difficulty: data.difficulty || null,
        instrumentation: data.instrumentation || null,
        metadata: JSON.stringify(data.metadata || {})
    });
    // return a normalized piece object including collection info when available
    return await getPieceById(pieceId);
}

export async function getPieceById(pieceId) {
    const piece = await db('pieces').where({ id: pieceId }).first();
    if (!piece) return null;
    piece.tags = await db('piece_tags')
        .join('tags', 'piece_tags.tag_id', 'tags.id')
        .where('piece_tags.piece_id', pieceId)
        .select('tags.id','tags.name');
    // normalize quantity to number for API consumers
    piece.quantity = piece.quantity != null ? Number(piece.quantity) : 1;
    // include collection data when present
    if (piece.collection_id) {
        const col = await db('collections').where({ id: piece.collection_id }).first();
        if (col) piece.collection = { id: col.id, name: col.name, library_number: col.library_number };
        else piece.collection = null;
    } else {
        piece.collection = null;
    }
    return piece;
}

export async function getPieces(libraryId) {
    // Backwards-compatible: return all pieces when called without pagination
    const pieces = await db('pieces')
        .where({ library_id: libraryId });
    const pieceIds = pieces.map(p => p.id);
    if (pieceIds.length === 0) return [];
    const tagRows = await db('piece_tags')
        .join('tags', 'piece_tags.tag_id', 'tags.id')
        .whereIn('piece_tags.piece_id', pieceIds)
        .select('piece_tags.piece_id as piece_id', 'tags.id as id', 'tags.name as name');
    const tagsByPiece = {};
    for (const row of tagRows) {
        tagsByPiece[row.piece_id] = tagsByPiece[row.piece_id] || [];
        tagsByPiece[row.piece_id].push({ id: row.id, name: row.name });
    }
    // fetch collections referenced by these pieces
    const collectionIds = [...new Set(pieces.map(p => p.collection_id).filter(Boolean))];
    let collectionsById = {};
    if (collectionIds.length) {
        const cols = await db('collections').whereIn('id', collectionIds).select('id','name','library_number');
        for (const c of cols) collectionsById[c.id] = c;
    }
    return pieces.map(p => ({ ...p, tags: tagsByPiece[p.id] || [], quantity: p.quantity != null ? Number(p.quantity) : 1, collection: p.collection_id ? (collectionsById[p.collection_id] || null) : null }));
}

// New: paginated fetch for pieces. Returns { pieces, total }
export async function getPiecesPaged(libraryId, { page = 1, perPage = 20, sortField = 'title', sortDir = 'asc' } = {}) {
    const p = Math.max(1, Number(page) || 1)
    // enforce a maximum per-page to avoid very large responses / expensive queries
    const PIECES_MAX_PER_PAGE = Number(process.env.PIECES_MAX_PER_PAGE || 200)
    const ppRaw = Number(perPage) || 20
    const pp = Math.max(1, Math.min(ppRaw, PIECES_MAX_PER_PAGE))
    const offset = (p - 1) * pp

    // get total count
    const [{ count }] = await db('pieces').where({ library_id: libraryId }).count('* as count')
    const total = Number(count || 0)

    // fetch paged rows with ordering
    // Whitelist allowed sort fields to avoid SQL errors or unintended column access
    const allowedSortFields = ['title', 'composer', 'library_number', 'created_at', 'instrumentation', 'quantity']
    const defaultSort = 'title'
    const sf = String(sortField || defaultSort).toLowerCase()
    const orderField = allowedSortFields.includes(sf) ? sf : defaultSort
    const dir = (String(sortDir || 'asc').toLowerCase() === 'desc') ? 'desc' : 'asc'

    const rows = await db('pieces').where({ library_id: libraryId }).orderBy(orderField, dir).limit(pp).offset(offset)

    if (!rows || rows.length === 0) return { pieces: [], total }

    const pieceIds = rows.map(p => p.id)
    const tagRows = await db('piece_tags')
        .join('tags', 'piece_tags.tag_id', 'tags.id')
        .whereIn('piece_tags.piece_id', pieceIds)
        .select('piece_tags.piece_id as piece_id', 'tags.id as id', 'tags.name as name');
    const tagsByPiece = {};
    for (const row of tagRows) {
        tagsByPiece[row.piece_id] = tagsByPiece[row.piece_id] || [];
        tagsByPiece[row.piece_id].push({ id: row.id, name: row.name });
    }

    const collectionIds = [...new Set(rows.map(p => p.collection_id).filter(Boolean))];
    let collectionsById = {};
    if (collectionIds.length) {
        const cols = await db('collections').whereIn('id', collectionIds).select('id','name','library_number');
        for (const c of cols) collectionsById[c.id] = c;
    }

    const piecesOut = rows.map(p => ({ ...p, tags: tagsByPiece[p.id] || [], quantity: p.quantity != null ? Number(p.quantity) : 1, collection: p.collection_id ? (collectionsById[p.collection_id] || null) : null }))
    return { pieces: piecesOut, total }
}

export async function updatePiece(pieceId, data) {
    // normalize publisher to string for varchar column
    let publisherValue = null
    if (data.publisher) {
        if (typeof data.publisher === 'string') publisherValue = data.publisher
        else if (typeof data.publisher === 'object' && data.publisher.name) publisherValue = data.publisher.name
        else publisherValue = String(data.publisher)
    }

    // Validate collection_id if provided, and build update object conditionally
    const existing = await db('pieces').where({ id: pieceId }).first();
    if (!existing) throw new Error('Piece not found');

    const update = {
        title: data.title,
        composer: data.composer,
        arranger: data.arranger || null,
        publisher: publisherValue,
        quantity: Number.isFinite(Number(data.quantity)) ? Number(data.quantity) : 1,
        library_number: data.library_number || null,
        difficulty: data.difficulty || null,
        instrumentation: data.instrumentation || null,
        metadata: JSON.stringify(data.metadata || {}),
        updated_at: db.fn.now()
    };

    if (typeof data.collection_id !== 'undefined') {
        if (data.collection_id === null) {
            update.collection_id = null;
        } else {
            const col = await db('collections').where({ id: data.collection_id }).first();
            if (!col) throw new Error('Invalid collection_id');
            if (String(col.library_id) !== String(existing.library_id)) throw new Error('collection does not belong to piece library');
            update.collection_id = data.collection_id;
        }
    }

    await db('pieces').where({ id: pieceId }).update(update);
    return await getPieceById(pieceId);
}

export async function deletePiece(pieceId) {
    await db('pieces')
        .where({ id: pieceId })
        .del();
}

export async function searchPieces(libraryId, query, opts = {}) {
    const q = (query || '').trim();
    const byTitle = !!opts.byTitle
    const byComposer = !!opts.byComposer
    const byLibNumber = !!opts.byLibNumber

    const piecesQuery = db('pieces').where({ library_id: libraryId });

    if (!q) {
        // empty query -> return all pieces for the library
        const allPieces = await piecesQuery;
        const allIds = allPieces.map(p => p.id);
        if (allIds.length === 0) return [];
        const tagRows = await db('piece_tags')
            .join('tags', 'piece_tags.tag_id', 'tags.id')
            .whereIn('piece_tags.piece_id', allIds)
            .select('piece_tags.piece_id as piece_id', 'tags.id as id', 'tags.name as name');
        const tagsByPiece = {};
        for (const row of tagRows) {
            tagsByPiece[row.piece_id] = tagsByPiece[row.piece_id] || [];
            tagsByPiece[row.piece_id].push({ id: row.id, name: row.name });
        }
        return allPieces.map(p => ({ ...p, tags: tagsByPiece[p.id] || [], quantity: p.quantity != null ? Number(p.quantity) : 1 }));
    }

    const like = `%${q}%`;
    piecesQuery.andWhere(function() {
        // if no specific field selected, default to title OR composer
        if (!byTitle && !byComposer && !byLibNumber) {
            this.where('title', 'like', like).orWhere('composer', 'like', like);
            return
        }
        // otherwise, OR together the selected fields
        if (byTitle) this.orWhere('title', 'like', like);
        if (byComposer) this.orWhere('composer', 'like', like);
        if (byLibNumber) this.orWhere('library_number', 'like', like);
    });

    const pieces = await piecesQuery;
    const pieceIds = pieces.map(p => p.id);
    if (pieceIds.length === 0) return [];
    const tagRows = await db('piece_tags')
        .join('tags', 'piece_tags.tag_id', 'tags.id')
        .whereIn('piece_tags.piece_id', pieceIds)
        .select('piece_tags.piece_id as piece_id', 'tags.id as id', 'tags.name as name');
    const tagsByPiece = {};
    for (const row of tagRows) {
        tagsByPiece[row.piece_id] = tagsByPiece[row.piece_id] || [];
        tagsByPiece[row.piece_id].push({ id: row.id, name: row.name });
    }
    return pieces.map(p => ({ ...p, tags: tagsByPiece[p.id] || [], quantity: p.quantity != null ? Number(p.quantity) : 1 }));
}

export async function findPieceByTitleAndComposer(libraryId, title, composer) {
    if (!title) return null;
    const q = db('pieces').where({ library_id: libraryId });
    q.andWhere('title', String(title));
    if (composer) q.andWhere('composer', String(composer));
    const piece = await q.first();
    return piece || null;
}

// Search pieces across other libraries in the same organization (used for autofill suggestions)
export async function searchPiecesInOrgLibraries({ libraryId, orgId, query, maxResults = 10, includeExternal = false }) {
    // If includeExternal is false we require orgId; otherwise includeExternal will search across orgs
    if (!includeExternal && !orgId) return [];

    // determine candidate libraries
    let libs = [];
    if (includeExternal) {
        // include libraries only from organizations that have explicitly opted in (allow_sharing = true)
        const allowedOrgs = await db('organizations').where({ allow_sharing: true }).select('id');
        const allowedOrgIds = allowedOrgs.map(o => o.id);
        if (allowedOrgIds.length === 0) return [];
        libs = await db('libraries').whereIn('organization_id', allowedOrgIds).select('id');
    } else {
        // get other libraries in the org
        libs = await db('libraries').where({ organization_id: orgId }).select('id');
    }
    const libIds = libs.map(l => l.id).filter(id => id !== libraryId);
    if (libIds.length === 0) return [];

    const q = (query || '').trim();
    // query pieces from the candidate libraries (do not join libraries or select library names)
    const piecesQuery = db('pieces')
        .whereIn('library_id', libIds)
        .select('pieces.*');
    if (q) {
        const like = `%${q}%`;
        piecesQuery.andWhere(function() {
            this.where('title', 'like', like).orWhere('composer', 'like', like).orWhere('library_number', 'like', like);
        });
    }
    piecesQuery.limit(maxResults);

    const pieces = await piecesQuery;
    if (!pieces || pieces.length === 0) return [];

    const pieceIds = pieces.map(p => p.id);
    const tagRows = await db('piece_tags')
        .join('tags', 'piece_tags.tag_id', 'tags.id')
        .whereIn('piece_tags.piece_id', pieceIds)
        .select('piece_tags.piece_id as piece_id', 'tags.id as id', 'tags.name as name');
    const tagsByPiece = {};
    for (const row of tagRows) {
        tagsByPiece[row.piece_id] = tagsByPiece[row.piece_id] || [];
        tagsByPiece[row.piece_id].push({ id: row.id, name: row.name });
    }
    return pieces.map(p => ({ ...p, tags: tagsByPiece[p.id] || [], quantity: p.quantity != null ? Number(p.quantity) : 1 }));
}

// Find potential duplicate pieces in a library.
// Returns an array of groups where each group has:
// { titleKey, titleExample, severity: 'high'|'medium', pieces: [ ...pieces ] }
// severity = 'high' when title and composer normalize identically across the group
// severity = 'medium' when title matches but composers differ
export async function findDuplicatesInLibrary(libraryId) {
    if (!libraryId) return [];
    const rows = await db('pieces').where({ library_id: libraryId }).select('id','title','composer','arranger','publisher','library_number','instrumentation','metadata');
    if (!rows || rows.length === 0) return [];

    // Normalization: trim, collapse whitespace, remove punctuation, lowercase
    function normalize(s) {
        if (!s && s !== 0) return '';
        return String(s)
            .replace(/[\u2018\u2019\u201C\u201D]/g, "'") // normalize smart quotes
            .replace(/[^\w\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    // Levenshtein distance
    function levenshtein(a, b) {
        const m = a.length, n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;
        const v0 = new Array(n + 1), v1 = new Array(n + 1);
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

    function similarity(a, b) {
        if (!a && !b) return 1;
        if (!a || !b) return 0;
        const la = a.length, lb = b.length;
        const dist = levenshtein(a, b);
        const max = Math.max(la, lb);
        if (max === 0) return 1;
        return 1 - (dist / max);
    }

    // Composer similarity: treat surnames as primary match (handles 'Dawson, W.L.' vs 'wdawson')
    function composerSimilar(aRaw, bRaw) {
        const aNorm = normalize(aRaw || '');
        const bNorm = normalize(bRaw || '');
        if (!aNorm || !bNorm) return false;

        // derive surname candidates from raw: if format 'Last, First' is used, take the part before comma
        function surnameFromRaw(raw, norm) {
            if (!raw) return '';
            if (raw.includes(',')) {
                const parts = raw.split(',');
                return normalize(parts[0] || '');
            }
            const tokens = norm.split(' ').filter(Boolean);
            return tokens.length ? tokens[tokens.length - 1] : '';
        }

        const aSurname = surnameFromRaw(aRaw, aNorm);
        const bSurname = surnameFromRaw(bRaw, bNorm);

        if (aSurname && bSurname && aSurname === bSurname) return true;
        // containment: one normalized string contains the other's surname (handles wdawson vs dawson)
        if (aNorm.includes(bSurname) || bNorm.includes(aSurname)) return true;
        // token intersection: any token matches
        const aTokens = aNorm.split(' ').filter(Boolean);
        const bTokens = bNorm.split(' ').filter(Boolean);
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
    const items = rows.map(r => ({
        raw: r,
        nkTitle: normalize(r.title || ''),
        nkComposer: normalize(r.composer || '')
    }));

    const used = new Array(items.length).fill(false);
    const groups = [];

    // First: detect exact library_number conflicts (very-high severity)
    const libNumMap = {};
    items.forEach((it, idx) => {
        const num = (it.raw.library_number || '').toString().trim();
        if (!num) return;
        if (!libNumMap[num]) libNumMap[num] = [];
        libNumMap[num].push(idx);
    });
    for (const num of Object.keys(libNumMap)) {
        const idxs = libNumMap[num];
        if (idxs.length > 1) {
            const pieces = idxs.map(i => items[i].raw);
            groups.push({ titleKey: `libnum:${num}`, titleExample: `Library #${num}`, severity: 'very-high', pieces });
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
        const key = (items[idx].nkTitle || '').slice(0, BUCKET_PREFIX_LEN);
        if (!bucketMap.has(key)) bucketMap.set(key, []);
        bucketMap.get(key).push(idx);
    }

    for (const [prefix, idxs] of bucketMap.entries()) {
        // run clustering within this bucket
        for (let bi = 0; bi < idxs.length; bi++) {
            const i = idxs[bi];
            if (used[i]) continue;
            const base = items[i];
            const cluster = { titleKey: base.nkTitle, titleExample: base.raw.title || '', pieces: [base.raw] };
            used[i] = true;
            for (let bj = bi + 1; bj < idxs.length; bj++) {
                const j = idxs[bj];
                if (used[j]) continue;
                const other = items[j];
                const titleSim = similarity(base.nkTitle, other.nkTitle);
                const baseCompRaw = base.raw.composer || '';
                const otherCompRaw = other.raw.composer || '';

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
    const results = groups.map(g => {
        if (g.severity === 'very-high') return g;
        // compute composer similarity across pieces in the group
        const comps = g.pieces.map(p => normalize(p.composer || ''));
        const nonEmpty = comps.filter(c => c !== '');
        let severity = 'medium';
        if (nonEmpty.length > 0) {
            const ref = nonEmpty[0];
            const allSimilar = nonEmpty.every(c => {
                // surname equal or string similarity
                if (!c) return false;
                const surnameMatch = (() => {
                    const aTokens = ref.split(' ').filter(Boolean);
                    const bTokens = c.split(' ').filter(Boolean);
                    return aTokens.length && bTokens.length && aTokens[aTokens.length - 1] === bTokens[bTokens.length - 1];
                })();
                return surnameMatch || similarity(ref, c) >= COMPOSER_SIM_THRESHOLD;
            });
            if (allSimilar) {
                // check title strictness for the group
                let minTitleSim = 1;
                for (let a = 0; a < g.pieces.length; a++) for (let b = a + 1; b < g.pieces.length; b++) {
                    const ta = normalize(g.pieces[a].title || '');
                    const tb = normalize(g.pieces[b].title || '');
                    minTitleSim = Math.min(minTitleSim, similarity(ta, tb));
                }
                if (minTitleSim >= TITLE_STRICT_THRESHOLD) severity = 'high';
                else severity = 'medium';
            }
        }
        return { titleKey: g.titleKey, titleExample: g.titleExample, severity, pieces: g.pieces };
    });

    // sort very-high then high then medium, then by title
    results.sort((a,b) => {
        const order = { 'very-high': 0, 'high': 1, 'medium': 2 };
        const oa = order[a.severity] ?? 3;
        const ob = order[b.severity] ?? 3;
        if (oa !== ob) return oa - ob;
        return (a.titleExample || '').localeCompare(b.titleExample || '');
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
        if (latest && (latest.scanning || (latest.cachedAt))) {
            return latest;
        }

        // No cached result exists; decide sync vs async by piece count
        const row = await db('pieces').where({ library_id: libraryId }).count({ cnt: '*' }).first();
        const cnt = Number(row?.cnt || 0);
        if (cnt > DUP_ASYNC_THRESHOLD) {
            // large library: schedule an async scan and return scanning state
            await dupQueue.scheduleScan(libraryId);
            return { groups: [], cachedAt: null, scanning: true };
        }

        // small library: compute synchronously and persist a done job
        const groups = await findDuplicatesInLibrary(libraryId);
        try {
            await db('duplicate_scan_jobs').insert({ library_id: libraryId, status: 'done', result: JSON.stringify(groups), cached_at: Date.now(), attempts: 0, created_at: db.fn.now(), updated_at: db.fn.now() });
        } catch (e) {
            // ignore DB insert errors but log
            console.warn('Failed to persist duplicate scan job result:', e);
        }
        return { groups, cachedAt: Date.now(), scanning: false };
    } catch (err) {
        console.error('findDuplicatesInLibraryCached error', err);
        return { groups: [], cachedAt: null, scanning: false };
    }
}

