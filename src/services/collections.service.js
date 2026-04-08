import db from '../config/knex.js'
import { generateUUID } from '../utils/uuid.js'

export async function createCollection({ libraryId, name, library_number = null, metadata = null }) {
  const id = generateUUID();
  await db('collections').insert({ id, library_id: libraryId, name, library_number: library_number || null, metadata: JSON.stringify(metadata || {}), created_at: db.fn.now(), updated_at: db.fn.now() });
  return { id, library_id: libraryId, name, library_number: library_number || null, metadata: metadata || {} };
}

export async function getCollectionsForLibrary(libraryId) {
  const rows = await db('collections').where({ library_id: libraryId }).select('*').orderBy('name');
  return rows.map(r => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : null }));
}

export async function getCollectionById(collectionId) {
  const row = await db('collections').where({ id: collectionId }).first();
  if (!row) return null;
  return { ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null };
}

export async function updateCollection(collectionId, { name, library_number, metadata }) {
  const update = {};
  if (typeof name !== 'undefined') update.name = name;
  if (typeof library_number !== 'undefined') update.library_number = library_number;
  if (typeof metadata !== 'undefined') update.metadata = JSON.stringify(metadata || {});
  if (Object.keys(update).length === 0) return await getCollectionById(collectionId);
  update.updated_at = db.fn.now();
  await db('collections').where({ id: collectionId }).update(update);
  return await getCollectionById(collectionId);
}

export async function deleteCollection(collectionId) {
  // When deleting a collection, set collection_id on pieces to null
  return await db.transaction(async (trx) => {
    await trx('pieces').where({ collection_id: collectionId }).update({ collection_id: null });
    await trx('collections').where({ id: collectionId }).del();
  });
}

