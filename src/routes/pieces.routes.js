import express from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { requireOrgRole, requireLibraryRole } from '../middleware/role.middleware.js';
import * as piecesController from '../controllers/pieces.controller.js';

const router = express.Router();

// Create a piece in a library
router.post('/:libraryId', authenticate, requireLibraryRole(), piecesController.createPiece);
// List pieces in a library (matches db-test which requests GET /pieces/:libraryId)
router.get('/:libraryId', authenticate, piecesController.getPieces);

// Piece-specific endpoints use a distinct path to avoid conflict with libraryId route
router.get('/id/:pieceId', authenticate, piecesController.getPiece);
router.put('/id/:pieceId', authenticate, requireOrgRole(), piecesController.updatePiece);
router.delete('/id/:pieceId', authenticate, requireOrgRole(), piecesController.deletePiece);

// additional helpers
router.get('/search/:libraryId', authenticate, piecesController.searchPieces);
router.get('/library/:libraryId', authenticate, piecesController.getPieces);

export default router;