import express from "express";
import { authenticate } from "../middleware/auth.middleware.js";
import {
  requireOrgRole,
  requireLibraryRole,
} from "../middleware/role.middleware.js";
import * as piecesController from "../controllers/pieces.controller.js";
import * as tagsController from "../controllers/tags.controller.js";
import * as commentsController from "../controllers/comments.controller.js";

const router = express.Router();

// Create a piece in a library
router.post(
  "/:libraryId",
  authenticate,
  requireLibraryRole(),
  piecesController.createPiece,
);
// List pieces in a library (matches db-test which requests GET /pieces/:libraryId)
router.get("/:libraryId", authenticate, piecesController.getPieces);

// Piece-specific endpoints use a distinct path to avoid conflict with libraryId route
router.get("/id/:pieceId", authenticate, piecesController.getPiece);
router.put(
  "/id/:pieceId",
  authenticate,
  requireOrgRole(),
  piecesController.updatePiece,
);
router.delete(
  "/id/:pieceId",
  authenticate,
  requireOrgRole(),
  piecesController.deletePiece,
);

// additional helpers
router.get("/search/:libraryId", authenticate, piecesController.searchPieces);
// autofill suggestions from other libraries in the same organization
router.get(
  "/autofill/:libraryId",
  authenticate,
  piecesController.autofillFromOrgLibraries,
);
router.get("/library/:libraryId", authenticate, piecesController.getPieces);

// piece tags
router.get("/id/:pieceId/tags", authenticate, tagsController.getTagsForPiece);
router.post(
  "/id/:pieceId/tags",
  authenticate,
  requireLibraryRole(),
  tagsController.attachTag,
);
router.delete(
  "/id/:pieceId/tags",
  authenticate,
  requireLibraryRole(),
  tagsController.detachTag,
);

// piece comments: GET available to members; POST allowed to editor+ roles; PUT/DELETE for comment edit/delete
router.get(
  "/id/:pieceId/comments",
  authenticate,
  commentsController.getComments,
);
router.post(
  "/id/:pieceId/comments",
  authenticate,
  requireOrgRole(),
  commentsController.addComment,
);
router.put(
  "/id/:pieceId/comments/:commentId",
  authenticate,
  commentsController.updateComment,
);
router.delete(
  "/id/:pieceId/comments/:commentId",
  authenticate,
  commentsController.deleteComment,
);

export default router;
