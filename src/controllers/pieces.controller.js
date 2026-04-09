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

const MAX_QUANTITY = 1000000

// Maximum pieces per-page allowed (configurable via env)
const PIECES_MAX_PER_PAGE = Number(process.env.PIECES_MAX_PER_PAGE || 200)

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
  if (data.quantity !== undefined) {
    const q = Number(data.quantity)
    if (!Number.isFinite(q) || q < 0 || q > MAX_QUANTITY) errors.push('quantity value is invalid')
  }
  return errors
}

export async function createPiece(req, res) {
    try {

        const data = req.body; // include title, composer, difficulty, quantity, etc.
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
        // If pagination params are provided, use paged service to avoid returning full dataset for large libraries
        const page = req.query && (req.query.page || req.query.per_page || req.query.perPage)
        if (page) {
            const pageNum = Number(req.query.page) || 1
            const perPageRaw = Number(req.query.per_page || req.query.perPage) || 20
            const perPage = Math.max(1, Math.min(perPageRaw, PIECES_MAX_PER_PAGE))
            const sortField = req.query.sortField || req.query.sort || 'title'
            const sortDir = req.query.sortDir || req.query.sort_dir || req.query.sortDirection || 'asc'
            const result = await piecesService.getPiecesPaged(req.params.libraryId, { page: pageNum, perPage, sortField, sortDir })
            // result may include collections for client convenience
            return res.status(200).json({ pieces: result.pieces, total: result.total, collections: result.collections || [] })
        }
        const pieces = await piecesService.getPieces(req.params.libraryId);
        res.status(200).json(pieces);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function updatePiece(req, res) {
    try {
        const { title, composer, arranger, instrumentation, difficulty, publisher, metadata, library_number, quantity } = req.body;
        const data = { title, composer, arranger, instrumentation, difficulty, publisher, metadata, library_number, quantity }
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
        const includeExternal = req.query.includeExternal === 'true' || req.query.includeExternal === '1' || req.query.includeExternal === 'on' || req.query.includeExternal === true;
        // If includeExternal is true, expand search to libraries outside the org (respecting org opt-out)
        let pieces;
        if (includeExternal) {
            // get the library to obtain its organization id
            const lib = await librariesService.getLibraryById(req.params.libraryId);
            const orgId = lib ? lib.organization_id : null;
            pieces = await piecesService.searchPiecesInOrgLibraries({ libraryId: req.params.libraryId, orgId, query, maxResults: 200, includeExternal: true });
        } else {
            pieces = await piecesService.searchPieces(req.params.libraryId, query, { byTitle, byComposer, byLibNumber });
        }
        res.status(200).json(pieces);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

// Autocomplete / autofill: search other libraries in the same organization for matching pieces
export async function autofillFromOrgLibraries(req, res) {
    try {
        const { libraryId } = req.params;
        const { query } = req.query;
        if (!libraryId) return res.status(400).json({ error: 'libraryId required' });

        // ensure library exists and get its org
        const lib = await librariesService.getLibraryById(libraryId);
        if (!lib) return res.status(404).json({ error: 'library not found' });

        const orgId = lib.organization_id;
        if (!orgId) return res.status(400).json({ error: 'library not associated with an organization' });

        // parse includeExternal flag from query string (true/1/on)
        const includeExternal = req.query.includeExternal === 'true' || req.query.includeExternal === '1' || req.query.includeExternal === 'on' || req.query.includeExternal === true;

        const results = await piecesService.searchPiecesInOrgLibraries({ libraryId, orgId, query, maxResults: 20, includeExternal });
        // Only return lightweight fields for autofill
        const payload = results.map(r => ({
            id: r.id,
            library_id: r.library_id,
            title: r.title,
            composer: r.composer,
            arranger: r.arranger,
            publisher: r.publisher,
            library_number: r.library_number,
            tags: r.tags || [],
            quantity: r.quantity != null ? Number(r.quantity) : 1
        }));
        res.status(200).json(payload);
    } catch (error) {
        console.error('autofillFromOrgLibraries error', error);
        res.status(500).json({ error: error.message });
    }
}

