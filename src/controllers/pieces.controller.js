import * as piecesService from "../services/pieces.service.js";

export async function createPiece(req, res) {
    try {

        const data = req.body; // include title, composer, difficulty, etc.
        const piece = await piecesService.createPiece({
            libraryId: req.params.libraryId,
            creatorId: req.user.id,
            data
        });
        res.status(201).json(piece);
    } catch (error) {
        console.error('Error in createPiece:', error);
        res.status(400).json({ error: error.message });
    }
}

export async function getPiece(req, res) {
    try {
        const piece = await piecesService.getPieceById(req.params.pieceId);
        if (!piece) {
            return res.status(404).json({ error: 'Piece not found' });
        }
        res.status(200).json(piece);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function getPieces(req, res) {
    try {
        const pieces = await piecesService.getPieces(req.params.libraryId);
        res.status(200).json(pieces);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function updatePiece(req, res) {
    try {
        const { title, content } = req.body;
        const updatedPiece = await piecesService.updatePiece(req.params.pieceId, {
            title,
            content
        });
        res.status(200).json(updatedPiece);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}

export async function deletePiece(req, res) {
    try {
        await piecesService.deletePiece(req.params.pieceId);
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}
export async function searchPieces(req, res) {
    try {
        const { query } = req.query;
        const pieces = await piecesService.searchPieces(req.params.libraryId, query);
        res.status(200).json(pieces);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}