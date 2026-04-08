import db from '../config/knex.js'
import { generateUUID } from '../utils/uuid.js'

export async function createCollection({ libraryId, name, library_number = null, metadata = null }) {
  const id = generateUUID();
  // Accept metadata as object or JSON string; normalize to object before storing
  let metaObj = {};
  if (typeof metadata === 'string') {
    try { metaObj = JSON.parse(metadata); } catch (e) { metaObj = {} }
  } else if (metadata && typeof metadata === 'object') metaObj = metadata
  await db('collections').insert({ id, library_id: libraryId, name, library_number: library_number || null, metadata: JSON.stringify(metaObj || {}), created_at: db.fn.now(), updated_at: db.fn.now() });
  return { id, library_id: libraryId, name, library_number: library_number || null, metadata: metaObj || {} };
}

export async function getCollectionsForLibrary(libraryId) {
  const rows = await db('collections').where({ library_id: libraryId }).select('*').orderBy('name');
  return rows.map(r => {
    let meta = null;
    if (typeof r.metadata === 'string') {
      try { meta = JSON.parse(r.metadata); } catch (e) { meta = null }
    } else if (r.metadata && typeof r.metadata === 'object') {
      meta = r.metadata
    } else {
      meta = null
    }
    return { ...r, metadata: meta };
  });
}

export async function getCollectionById(collectionId) {
  const row = await db('collections').where({ id: collectionId }).first();
  if (!row) return null;
  let meta = null;
  if (typeof row.metadata === 'string') {
    try { meta = JSON.parse(row.metadata); } catch (e) { meta = null }
  } else if (row.metadata && typeof row.metadata === 'object') {
    meta = row.metadata
  } else meta = null;
  return { ...row, metadata: meta };
}

export async function updateCollection(collectionId, { name, library_number, metadata }) {
  const update = {};
  if (typeof name !== 'undefined') update.name = name;
  if (typeof library_number !== 'undefined') update.library_number = library_number;
  if (typeof metadata !== 'undefined') {
    // normalize incoming metadata (accept object or JSON string)
    let metaObj = {};
    if (typeof metadata === 'string') {
      try { metaObj = JSON.parse(metadata); } catch (e) { metaObj = {} }
    } else if (metadata && typeof metadata === 'object') metaObj = metadata
    update.metadata = JSON.stringify(metaObj || {});
  }
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

