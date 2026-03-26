import * as libraryService from '../services/libraries.service.js';
import * as piecesService from '../services/pieces.service.js';
import * as tagsService from '../services/tags.service.js';
import crypto from 'crypto';

// Small in-memory cache to detect immediate duplicate import requests (keyed by user:library:hash)
// Entries live for a short TTL to avoid memory growth and to only protect against accidental double-submits.
const _recentImportCache = new Map();
const IMPORT_CACHE_TTL_MS = 5 * 1000; // 5 seconds

function _makeImportCacheKey(userId, libraryId, hash) {
    return `${userId}:${libraryId}:${hash}`;
}

function _cleanupImportCache() {
    const now = Date.now();
    for (const [k, v] of _recentImportCache.entries()) {
        if (now - v.ts > IMPORT_CACHE_TTL_MS) _recentImportCache.delete(k);
    }
}

// schedule periodic cleanup (low-frequency)
setInterval(_cleanupImportCache, IMPORT_CACHE_TTL_MS);

export async function createLibrary(req, res) {
    try {
        const { name } = req.body;
        const library = await libraryService.createLibrary({
            organizationId: req.params.organizationId,
            creatorID: req.user.id,
            name
        });
        res.status(201).json(library);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}

export async function getLibrary(req, res) {
    try {
        const library = await libraryService.getLibraryById(req.params.libraryId);
        if (!library) {
            return res.status(404).json({ error: 'Library not found' });
        }
        // include current user's membership on the library (if any)
        let membership = null;
        try {
            if (req.user && req.user.id) {
                membership = await libraryService.getMembershipForUser(req.params.libraryId, req.user.id);
            }
        } catch (e) {
            membership = null;
        }
        res.status(200).json({ ...library, membership });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function getLibraries(req, res) {
    try {
        const libraries = await libraryService.getLibraries(req.params.organizationId);
        res.status(200).json(libraries);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

// Generate a view-only token for a library (authenticated; requires library role of owner/admin)
export async function generateViewToken(req, res) {
    try {
        const libraryId = req.params.libraryId;
        const token = await libraryService.generateViewToken(libraryId);
        res.status(200).json({ view_token: token });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function revokeViewToken(req, res) {
    try {
        const libraryId = req.params.libraryId;
        await libraryService.revokeViewToken(libraryId);
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

// Public endpoint: GET /libraries/public/:token
export async function getLibraryByToken(req, res) {
    try {
        const token = req.params.token;
        const library = await libraryService.getLibraryByToken(token);
        if (!library) return res.status(404).json({ error: 'Library not found' });
        // include pieces and tags in read-only form
        const pieces = await piecesService.getPieces(library.id);
        res.status(200).json({ ...library, pieces });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function importFromSpreadsheet(req, res) {
    try {
        const libraryId = req.params.libraryId;
        const { rows } = req.body;
        if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be an array' });

        // log incoming request for debugging and compute a normalized hash (or use client-supplied importId)
        try {
            const userIdLog = req.user?.id || 'anon'
            // rows length intentionally not logged to reduce noise
            const clientImportId = req.body?.importId || null

            if (clientImportId) {
                const cacheKey = _makeImportCacheKey(userIdLog, libraryId, clientImportId)
                // import called with client importId (debug log removed)
                const cached = _recentImportCache.get(cacheKey)
                if (cached && (Date.now() - cached.ts) <= IMPORT_CACHE_TTL_MS) {
                    if (cached.processing) {
                        // import already in progress (suppressed debug message)
                        return res.status(202).json({ message: 'Import already in progress' })
                    }
                    // returning cached import result (suppressed debug message)
                    return res.status(200).json(cached.result)
                }
                // mark as processing immediately and remember cacheKey
                _recentImportCache.set(cacheKey, { ts: Date.now(), processing: true, result: null })
                req._importCacheKey = cacheKey
                req._normalizedImport = null
            } else {
                // create a normalized representation of rows for stable hashing
                const normalizedRows = (Array.isArray(rows) ? rows : []).map(r => {
                    const out = {}
                    // sort keys to produce deterministic JSON
                    Object.keys(r).sort().forEach(k => {
                        const v = r[k]
                        // normalize value: collapse whitespace and trim
                        out[k] = v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim()
                    })
                    return out
                })
                const hash = crypto.createHash('sha256').update(JSON.stringify(normalizedRows)).digest('hex')
                // import called (debug log removed)

                // detect accidental double submit: if we recently processed the identical payload for this user+library, return cached result
                const cacheKey = _makeImportCacheKey(userIdLog, libraryId, hash)
                const cached = _recentImportCache.get(cacheKey)
                if (cached && (Date.now() - cached.ts) <= IMPORT_CACHE_TTL_MS) {
                    if (cached.processing) {
                        // import already in progress (suppressed debug message)
                        return res.status(202).json({ message: 'Import already in progress' })
                    }
                    // returning cached import result (suppressed debug message)
                    return res.status(200).json(cached.result)
                }
                // mark as processing immediately so concurrent requests will be short-circuited
                _recentImportCache.set(cacheKey, { ts: Date.now(), processing: true, result: null })
                // stash normalizedRows and cacheKey on the local scope for reuse later
                req._normalizedImport = normalizedRows
                req._importCacheKey = cacheKey
            }
        } catch (logErr) {
            console.warn('Failed to compute import hash for logging:', logErr)
        }

        // Basic validation and insert (no dedupe) with per-request dedupe to avoid duplicate rows in the same payload
        const results = { created: 0, skipped: 0, failed: 0, errors: [] };
        const seenRowKeys = new Set();
        function _normalizeRowForKey(r) {
            const out = {};
            Object.keys(r).sort().forEach(k => {
                const v = r[k];
                out[k] = v === null || v === undefined ? '' : String(v).replace(/\s+/g, ' ').trim();
            });
            return JSON.stringify(out);
        }

        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            const rowKey = _normalizeRowForKey(r);
            if (seenRowKeys.has(rowKey)) {
                // duplicate row within same payload — skip
                results.skipped++;
                // skipped duplicate row in payload (debug suppressed)
                continue;
            }
            seenRowKeys.add(rowKey);
             // minimal required: title and composer
             if (!r.title || !String(r.title).trim()) {
                 results.failed++;
                 results.errors.push({ row: i + 1, error: 'Missing title' });
                 continue;
             }
             if (!r.composer || !String(r.composer).trim()) {
                 results.failed++;
                 results.errors.push({ row: i + 1, error: 'Missing composer' });
                 continue;
             }

             try {
                 // create piece unconditionally
                const piece = await piecesService.createPiece({ libraryId, data: r });
                // console.info(`Created piece id=${piece.id} title=${piece.title} composer=${piece.composer} row=${i+1}`)
                 // handle tags column (comma-separated names)
                 if (r.tags && String(r.tags).trim()) {
                     const tagNames = String(r.tags).split(/[,;]+/).map(s => s.trim()).filter(Boolean);
                     for (const name of tagNames) {
                         let tag = await tagsService.findTagByName(libraryId, name);
                         if (!tag) tag = await tagsService.createTag({ libraryId, name });
                         await tagsService.attachTagToPiece({ pieceId: piece.id, tagId: tag.id });
                     }
                 }
                 results.created++;
             } catch (err) {
                 results.failed++;
                 results.errors.push({ row: i + 1, error: err.message || 'Insert failed' });
             }
         }

        // store result in cache to protect against immediate duplicate submissions
        try {
            const cacheKey = req._importCacheKey;
            if (cacheKey) _recentImportCache.set(cacheKey, { ts: Date.now(), result: results });
        } catch (cacheErr) {
            console.warn('Failed to cache import result:', cacheErr);
        }

        res.status(200).json(results);
    } catch (error) {
        console.error('Import error', error && error.stack ? error.stack : error);
        res.status(500).json({ error: error.message });
    }
}
