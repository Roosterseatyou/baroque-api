import * as collectionsService from '../services/collections.service.js'

export async function listCollections(req, res) {
  try {
    const libraryId = req.params.libraryId;
    const q = (req.query && req.query.q) ? String(req.query.q).trim() : '';
    let rows;
    if (q) {
      // simple search by name or library_number
      const all = await collectionsService.getCollectionsForLibrary(libraryId);
      const qlow = q.toLowerCase();
      rows = all.filter(c => (c.name && c.name.toLowerCase().includes(qlow)) || (c.library_number && String(c.library_number).toLowerCase().includes(qlow)));
    } else {
      rows = await collectionsService.getCollectionsForLibrary(libraryId);
    }
    res.status(200).json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export async function createCollection(req, res) {
  try {
    const libraryId = req.params.libraryId;
    const { name, library_number, metadata } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const c = await collectionsService.createCollection({ libraryId, name, library_number, metadata });
    res.status(201).json(c);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export async function getCollection(req, res) {
  try {
    const id = req.params.collectionId;
    const c = await collectionsService.getCollectionById(id);
    if (!c) return res.status(404).json({ error: 'not found' });
    res.status(200).json(c);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export async function updateCollection(req, res) {
  try {
    const id = req.params.collectionId;
    const { name, library_number, metadata } = req.body || {};
    const updated = await collectionsService.updateCollection(id, { name, library_number, metadata });
    res.status(200).json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

export async function deleteCollection(req, res) {
  try {
    const id = req.params.collectionId;
    await collectionsService.deleteCollection(id);
    res.status(204).send();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

