import db from '../config/knex.js';
import { generateUUID } from '../utils/uuid.js';

export async function createTag({ libraryId, name }) {
    const id = generateUUID();
    await db('tags').insert({ id, library_id: libraryId, name });
    return { id, library_id: libraryId, name };
}

export async function getTagsForLibrary(libraryId) {
    try {
        const tags = await db('tags').where({ library_id: libraryId }).select('id', 'name');
        return tags;
    } catch (error) {
        console.error('DB error in getTagsForLibrary:', error && error.stack ? error.stack : error);
        throw error;
    }
}

export async function findTagByName(libraryId, name) {
    return db('tags').where({ library_id: libraryId, name }).first();
}

export async function attachTagToPiece({ pieceId, tagId }) {
    // avoid duplicate attachments
    const existing = await db('piece_tags').where({ piece_id: pieceId, tag_id: tagId }).first();
    if (existing) return existing;
    const id = generateUUID();
    await db('piece_tags').insert({ id, piece_id: pieceId, tag_id: tagId });
    return { id, piece_id: pieceId, tag_id: tagId };
}

export async function detachTagFromPiece({ pieceId, tagId }) {
    await db('piece_tags').where({ piece_id: pieceId, tag_id: tagId }).del();
}

export async function getTagsForPiece(pieceId) {
    const tags = await db('piece_tags')
        .join('tags', 'piece_tags.tag_id', 'tags.id')
        .where('piece_tags.piece_id', pieceId)
        .select('tags.id','tags.name');
    return tags;
}

export async function updateTag({ libraryId, tagId, name }) {
    // only update if tag belongs to provided libraryId for safety
    const updated = await db('tags')
        .where({ id: tagId, library_id: libraryId })
        .update({ name, updated_at: db.fn.now() });
    if (!updated) return null;
    const tag = await db('tags').where({ id: tagId }).first();
    return tag;
}
