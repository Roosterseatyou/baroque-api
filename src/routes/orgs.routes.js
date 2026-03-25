import express from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import * as orgsController from '../controllers/orgs.controller.js';
import { requireOrgRole } from '../middleware/role.middleware.js';

const router = express.Router();

router.post('/', authenticate, orgsController.createOrganization);
router.get('/:organizationId', authenticate, orgsController.getOrganization);
router.put('/:organizationId', authenticate, requireOrgRole(), orgsController.updateOrganization);
router.delete('/:organizationId', authenticate, requireOrgRole(), orgsController.deleteOrganization);
router.post('/:organizationId/invite', authenticate, requireOrgRole(), orgsController.addMember);
router.post('/:organizationId/remove', authenticate, requireOrgRole(), orgsController.removeMember);
router.get('/:organizationId/members', authenticate, requireOrgRole(), orgsController.getMembers);
// Restore soft-deleted organization
router.post('/:organizationId/restore', authenticate, orgsController.restoreOrganization);
// Hard delete (destructive) - authorized to admin secret or organization owner/admin/manager or original deleter
router.post('/:organizationId/hard-delete', authenticate, orgsController.hardDeleteOrganization);

export default router;