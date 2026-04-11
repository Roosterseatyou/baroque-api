import express from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import * as usersController from "../controllers/users.controller.js";

const router = express.Router();

router.get("/me", authenticate, usersController.me);
// Create default data for a user (e.g., personal org). Body may include { orgName }
router.post("/data", authenticate, usersController.createUserData);
// Safe delete the user's account and associated data (ownership transfer/delete logic)
router.delete("/data", authenticate, usersController.deleteUserData);
// Restore endpoints
router.post("/restore", authenticate, usersController.restoreUser); // self-restore
router.post("/:userId/restore", authenticate, usersController.restoreUser); // admin restore (requires ADMIN_SECRET)
// EXPLICIT: list deleted organizations for the current user. Must be defined before '/:userId' to avoid collision.
router.get(
  "/deleted-organizations",
  authenticate,
  usersController.getDeletedOrganizations,
);
// (debug route removed)
router.get("/:userId", authenticate, usersController.getUserProfile);
router.put("/:userId", authenticate, usersController.updateUserProfile);
router.delete("/:userId", authenticate, usersController.deleteUser);
router.get(
  "/:userId/libraries",
  authenticate,
  usersController.getUserLibraries,
);
router.get(
  "/:userId/organizations",
  authenticate,
  usersController.getUserOrganizations,
);

export default router;
