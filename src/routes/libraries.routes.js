import express from 'express';
import * as librariesController from '../controllers/libraries.controller.js';
import * as tagsController from '../controllers/tags.controller.js';
import { requireOrgRole, requireLibraryRole, requireOrgOrLibraryRole } from "../middleware/role.middleware.js";
import { authenticate } from "../middleware/auth.middleware.js";

const router = express.Router();

router.post('/:organizationId', authenticate, librariesController.createLibrary);
router.get('/:libraryId', authenticate, librariesController.getLibrary);
router.get('/organization/:organizationId', authenticate, requireOrgRole(), librariesController.getLibraries);

// tags
router.post('/:libraryId/tags', authenticate, requireLibraryRole(), tagsController.createTag);
router.get('/:libraryId/tags', authenticate, tagsController.getTags);
router.put('/:libraryId/tags/:tagId', authenticate, requireLibraryRole(), tagsController.updateTag);

// import pieces from spreadsheet (expects JSON rows mapped on client)
// router.post('/:libraryId/import', authenticate, requireLibraryRole(), librariesController.importFromSpreadsheet);
router.post('/:libraryId/import', authenticate, requireOrgOrLibraryRole(['owner','admin','editor']), librariesController.importFromSpreadsheet);

export default router;