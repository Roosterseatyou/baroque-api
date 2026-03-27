import express from 'express';
import * as librariesController from '../controllers/libraries.controller.js';
import * as tagsController from '../controllers/tags.controller.js';
import { requireOrgRole, requireLibraryRole, requireOrgOrLibraryRole } from "../middleware/role.middleware.js";
import { authenticate } from "../middleware/auth.middleware.js";

const router = express.Router();

// Public access by token (no auth)
router.get('/public/:token', librariesController.getLibraryByToken);

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

// Scan library for potential duplicates
router.get('/:libraryId/duplicates', authenticate, requireOrgOrLibraryRole(), librariesController.findLibraryDuplicates);

// Debug: return raw duplicates payload (no normalization) - requires org/library role
router.get('/:libraryId/duplicates/raw', authenticate, requireOrgOrLibraryRole(), librariesController.findLibraryDuplicatesRaw);

// Force refresh duplicates (auth + role required)
router.post('/:libraryId/duplicates/refresh', authenticate, requireOrgOrLibraryRole(['owner','admin']), librariesController.refreshLibraryDuplicates);

// Public duplicates endpoint (view-token)
router.get('/public/:token/duplicates', librariesController.findLibraryDuplicatesPublic);

// View-token management (generate/revoke) - requires at least org or library owner/admin
router.post('/:libraryId/view-token', authenticate, requireOrgOrLibraryRole(['owner','admin']), librariesController.generateViewToken);
router.delete('/:libraryId/view-token', authenticate, requireOrgOrLibraryRole(['owner','admin']), librariesController.revokeViewToken);

export default router;