import express from "express";
import * as authController from "../controllers/auth.controller.js";
import { authenticate } from "../middleware/auth.middleware.js";

const router = express.Router();

router.post("/register", authController.register);
router.post("/login", authController.login);
router.post("/refresh", authController.refresh);
router.post("/logout", authController.logout);

// sessions endpoints (protected)
router.get("/sessions", authenticate, authController.listSessions);
router.post("/sessions/revoke", authenticate, authController.revokeSession);

router.get("/google", authController.googleAuth);
router.get("/google/callback", authController.googleCallback);

export default router;
