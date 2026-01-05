import express from 'express';
import * as librariesController from '../controllers/libraries.controller.js';
import { requireOrgRole} from "../middleware/role.middleware.js";
import { authenticate } from "../middleware/auth.middleware.js";

const router = express.Router();

router.post('/:organizationId', authenticate, librariesController.createLibrary);
router.get('/:libraryId', authenticate, librariesController.getLibrary);
router.get('/organization/:organizationId', authenticate, requireOrgRole(), librariesController.getLibraries);

export default router;