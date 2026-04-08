import express from 'express'
import { authenticate } from '../middleware/auth.middleware.js'
import { requireLibraryRole } from '../middleware/role.middleware.js'
import * as collectionsController from '../controllers/collections.controller.js'

const router = express.Router({ mergeParams: true });

// List collections for a library
router.get('/', authenticate, collectionsController.listCollections);
// Create a collection in a library (requires library-level permission)
router.post('/', authenticate, requireLibraryRole(), collectionsController.createCollection);
// Get, update, delete a collection
router.get('/:collectionId', authenticate, collectionsController.getCollection);
router.put('/:collectionId', authenticate, requireLibraryRole(), collectionsController.updateCollection);
router.delete('/:collectionId', authenticate, requireLibraryRole(), collectionsController.deleteCollection);

export default router;

