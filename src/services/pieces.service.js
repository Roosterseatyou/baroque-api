import db from '../config/knex.js';
import { generateUUID } from '../utils/uuid.js';

export async function createPiece({ libraryId, data }) {
    const pieceId = generateUUID();

    await db('pieces').insert({
        id: pieceId,
        library_id: libraryId,
        title: data.title,
        composer: data.composer,
        arranger: data.arranger || null,
        publisher: data.publisher || null,
        difficulty: data.difficulty || null,
        instrumentation: data.instrumentation || null,
        metadata: JSON.stringify(data.metadata || {})
    });
    return { id: pieceId, library_id: libraryId, ...data };
}

export async function getPieceById(pieceId) {
    const piece = await db('pieces').where({ id: pieceId }).first();
    return piece;
}

export async function getPieces(libraryId) {
    const pieces = await db('pieces')
        .where({ library_id: libraryId });
    return pieces;
}

export async function updatePiece(pieceId, data) {
    await db('pieces')
        .where({ id: pieceId })
        .update({
            title: data.title,
            composer: data.composer,
            arranger: data.arranger || null,
            publisher: data.publisher || null,
            difficulty: data.difficulty || null,
            instrumentation: data.instrumentation || null,
            metadata: JSON.stringify(data.metadata || {}),
            updated_at: db.fn.now()
        });
    const updatedPiece = await getPieceById(pieceId);
    return updatedPiece;
}

export async function deletePiece(pieceId) {
    await db('pieces')
        .where({ id: pieceId })
        .del();
}

export async function searchPieces(libraryId, query) {
    const pieces = await db('pieces')
        .where({ library_id: libraryId })
        .andWhere(function() {
            this.where('title', 'ilike', `%${query}%`)
                .orWhere('composer', 'ilike', `%${query}%`)
                .orWhere('arranger', 'ilike', `%${query}%`);
        });
    return pieces;
}

