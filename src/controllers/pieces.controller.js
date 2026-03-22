import * as piecesService from "../services/pieces.service.js";
import * as librariesService from "../services/libraries.service.js";
import * as orgsService from "../services/orgs.service.js";

const ALLOWED_DIFFICULTIES = ['', 'Beginner', 'Easy', 'Medium', 'Hard', 'Advanced']
const MAX_LEN = {
  title: 200,
  composer: 200,
  arranger: 200,
  instrumentation: 200,
  publisher: 200,
  library_number: 64
}

function validatePiecePayload(data) {
  const errors = [];
  if (!data || typeof data !== 'object') {
    errors.push('invalid payload')
    return errors
  }
  const title = (data.title || '').toString().trim()
  const composer = (data.composer || '').toString().trim()
  if (!title) errors.push('title is required')
  if (!composer) errors.push('composer is required')
  if (title && title.length > MAX_LEN.title) errors.push(`title must be <= ${MAX_LEN.title} characters`)
  if (composer && composer.length > MAX_LEN.composer) errors.push(`composer must be <= ${MAX_LEN.composer} characters`)
  if (data.arranger && data.arranger.length > MAX_LEN.arranger) errors.push(`arranger must be <= ${MAX_LEN.arranger} characters`)
  if (data.instrumentation && data.instrumentation.length > MAX_LEN.instrumentation) errors.push(`instrumentation must be <= ${MAX_LEN.instrumentation} characters`)
  if (data.publisher && data.publisher.length > MAX_LEN.publisher) errors.push(`publisher must be <= ${MAX_LEN.publisher} characters`)
  if (data.library_number && data.library_number.length > MAX_LEN.library_number) errors.push(`library_number must be <= ${MAX_LEN.library_number} characters`)
  if (data.difficulty && !ALLOWED_DIFFICULTIES.includes(data.difficulty)) errors.push('difficulty value is invalid')
  return errors
}

export async function createPiece(req, res) {
    try {

        const data = req.body; // include title, composer, difficulty, etc.
        const errors = validatePiecePayload(data)
        if (errors.length) return res.status(400).json({ errors })

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
        // include current user's library membership (if any)
        let membership = null;
        try {
            if (req.user && req.user.id && piece.library_id) {
                membership = await librariesService.getMembershipForUser(piece.library_id, req.user.id);
            }
        } catch (e) {
            membership = null;
        }
        // fallback: if no library membership, include org-level membership so org members (even without library membership) get proper UI permissions
        try {
            if (!membership && req.user && req.user.id && piece.library_id) {
                const lib = await librariesService.getLibraryById(piece.library_id);
                if (lib && lib.organization_id) {
                    membership = await orgsService.getMembershipForUser(lib.organization_id, req.user.id);
                }
            }
        } catch (e) {
            // non-fatal
        }
        res.status(200).json({ ...piece, membership });
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
        const { title, composer, arranger, instrumentation, difficulty, publisher, metadata, library_number } = req.body;
        const data = { title, composer, arranger, instrumentation, difficulty, publisher, metadata, library_number }
        const errors = validatePiecePayload(data)
        if (errors.length) return res.status(400).json({ errors })
        const updatedPiece = await piecesService.updatePiece(req.params.pieceId, data);
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
        // parse boolean flags from query string
        const byTitle = req.query.byTitle === 'true' || req.query.byTitle === '1' || req.query.byTitle === 'on' || req.query.byTitle === true;
        const byComposer = req.query.byComposer === 'true' || req.query.byComposer === '1' || req.query.byComposer === 'on' || req.query.byComposer === true;
        const byLibNumber = req.query.byLibNumber === 'true' || req.query.byLibNumber === '1' || req.query.byLibNumber === 'on' || req.query.byLibNumber === true;

        const pieces = await piecesService.searchPieces(req.params.libraryId, query, { byTitle, byComposer, byLibNumber });
        res.status(200).json(pieces);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}