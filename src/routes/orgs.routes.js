import express from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import * as orgsController from '../controllers/orgs.controller.js';
import { requireOrgRole } from '../middleware/role.middleware.js';

const router = express.Router();

router.post('/', authenticate, orgsController.createOrganization);
router.get('/:organizationId', authenticate, orgsController.getOrganization);
router.put('/:organizationId', authenticate, requireOrgRole(), orgsController.updateOrganization);
router.delete('/:organizationId', authenticate, requireOrgRole(), orgsController.deleteOrganization);
router.post('/:organizationId/invite', authenticate, requireOrgRole('admin'), orgsController.addMember);
router.post('/:organizationId/remove', authenticate, requireOrgRole('admin'), orgsController.removeMember);
router.get('/:organizationId/members', authenticate, requireOrgRole(), orgsController.getMembers);

export default router;