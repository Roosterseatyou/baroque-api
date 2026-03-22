import db from '../config/knex.js';
import { generateUUID } from '../utils/uuid.js';

export async function createPiece({ libraryId, data }) {
    const pieceId = generateUUID();

    // normalize publisher to string: if an object passed, extract .name; otherwise store string or null
    let publisherValue = null
    if (data.publisher) {
        if (typeof data.publisher === 'string') publisherValue = data.publisher
        else if (typeof data.publisher === 'object' && data.publisher.name) publisherValue = data.publisher.name
        else publisherValue = String(data.publisher)
    }

    await db('pieces').insert({
        id: pieceId,
        library_id: libraryId,
        title: data.title,
        composer: data.composer,
        arranger: data.arranger || null,
        publisher: publisherValue,
        library_number: data.library_number || null,
        difficulty: data.difficulty || null,
        instrumentation: data.instrumentation || null,
        metadata: JSON.stringify(data.metadata || {})
    });
    return { id: pieceId, library_id: libraryId, library_number: data.library_number || null, ...data };
}

export async function getPieceById(pieceId) {
    const piece = await db('pieces').where({ id: pieceId }).first();
    if (!piece) return null;
    piece.tags = await db('piece_tags')
        .join('tags', 'piece_tags.tag_id', 'tags.id')
        .where('piece_tags.piece_id', pieceId)
        .select('tags.id','tags.name');
    return piece;
}

export async function getPieces(libraryId) {
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
    return pieces.map(p => ({ ...p, tags: tagsByPiece[p.id] || [] }));
}

export async function updatePiece(pieceId, data) {
    // normalize publisher to string for varchar column
    let publisherValue = null
    if (data.publisher) {
        if (typeof data.publisher === 'string') publisherValue = data.publisher
        else if (typeof data.publisher === 'object' && data.publisher.name) publisherValue = data.publisher.name
        else publisherValue = String(data.publisher)
    }

    await db('pieces')
        .where({ id: pieceId })
        .update({
            title: data.title,
            composer: data.composer,
            arranger: data.arranger || null,
            publisher: publisherValue,
            library_number: data.library_number || null,
            difficulty: data.difficulty || null,
            instrumentation: data.instrumentation || null,
            metadata: JSON.stringify(data.metadata || {}),
            updated_at: db.fn.now()
        });
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
        return allPieces.map(p => ({ ...p, tags: tagsByPiece[p.id] || [] }));
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
    return pieces.map(p => ({ ...p, tags: tagsByPiece[p.id] || [] }));
}

export async function findPieceByTitleAndComposer(libraryId, title, composer) {
    if (!title) return null;
    const q = db('pieces').where({ library_id: libraryId });
    q.andWhere('title', String(title));
    if (composer) q.andWhere('composer', String(composer));
    const piece = await q.first();
    return piece || null;
}
