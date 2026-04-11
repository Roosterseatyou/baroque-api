import express from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import * as invitationsController from "../controllers/invitations.controller.js";
import { requireOrgRole } from "../middleware/role.middleware.js";

const router = express.Router();

// Create an invite for an organization (requires role: owner/admin/manager via requireOrgRole middleware)
router.post(
  "/:organizationId/invite",
  authenticate,
  requireOrgRole(),
  invitationsController.createInvite,
);

// List invites for the current user
router.get("/me", authenticate, invitationsController.listUserInvites);

// Respond to invite (accept/decline)
router.post(
  "/:inviteId/respond",
  authenticate,
  invitationsController.respondInvite,
);

export default router;
