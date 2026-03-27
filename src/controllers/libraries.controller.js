import * as libraryService from '../services/libraries.service.js';
import * as piecesService from '../services/pieces.service.js';
import * as tagsService from '../services/tags.service.js';
import * as dupQueue from '../services/dupQueue.service.js';
import crypto from 'crypto';

function _serverNormalizePayload(payload, opts = {}) {
    if (!payload) return { groups: [], cachedAt: null, scanning: false };
    // If payload is an array (legacy), return as groups
    if (Array.isArray(payload)) return { groups: payload, cachedAt: null, scanning: false };
    // If payload looks like a DB job row (has id and result), extract its result
    if (payload && payload.id && (payload.result !== undefined)) {
        payload = { groups: payload.result, cachedAt: payload.cached_at || payload.cachedAt, scanning: payload.status === 'pending' || payload.status === 'running' };
    }
    const out = { groups: [], cachedAt: null, scanning: false };
    // payload.groups may be JSON string, object, or array
    let raw = payload.groups;
    if (!raw) raw = [];
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch (e) { raw = [] }
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) {
        raw = Object.values(raw);
    }
    if (!Array.isArray(raw)) raw = [];
    // Ensure each group is an object and pieces is an array
    out.groups = raw.map(g => {
        if (!g || typeof g !== 'object') return null;
        const pieces = g.pieces || g.result || [];
        let parsedPieces;
        if (typeof pieces === 'string') {
            try { parsedPieces = JSON.parse(pieces) } catch (e) { parsedPieces = [] }
        } else if (Array.isArray(pieces)) parsedPieces = pieces
        else if (typeof pieces === 'object') parsedPieces = Object.values(pieces)
        else parsedPieces = []

        // Coerce each piece to expected shape and provide defaults
        parsedPieces = (parsedPieces || []).map(p => {
            if (!p || typeof p !== 'object') return null;
            return {
                id: p.id || p.ID || null,
                title: (p.title || p.name || '').toString().trim(),
                composer: (p.composer || '').toString().trim(),
                arranger: (p.arranger || '').toString().trim(),
                publisher: (p.publisher || '').toString().trim(),
                instrumentation: (p.instrumentation || '').toString().trim(),
                library_number: p.library_number || p.libraryNumber || p.lib_number || null,
            };
        }).filter(Boolean);

        // Remove pieces that have no meaningful data to avoid empty rows
        // Require at least a title, composer, or a library_number to consider a piece meaningful
        parsedPieces = parsedPieces.filter(pp => (pp.title && pp.title.length) || (pp.composer && pp.composer.length) || (pp.library_number && String(pp.library_number).length));

        // Deduplicate pieces by id or library_number
        const seenPieces = new Set();
        parsedPieces = parsedPieces.filter(pp => {
            const key = pp.id || (`libnum:${pp.library_number}`) || JSON.stringify(pp);
            if (seenPieces.has(key)) return false;
            seenPieces.add(key);
            return true;
        });

        // Only return groups that still have at least two valid pieces
        if (!Array.isArray(parsedPieces) || parsedPieces.length < 2) return null;
        const titleExample = g.titleExample || g.title_example || (parsedPieces[0] ? parsedPieces[0].title : '') || '';
        return { titleKey: g.titleKey || g.title_example || titleExample, titleExample, severity: g.severity || 'medium', pieces: parsedPieces };
    }).filter(Boolean);
    // Remove groups that have no pieces and deduplicate by titleKey
    const seen = new Set();
    let filtered = out.groups.filter(g => {
        if (!g || !Array.isArray(g.pieces) || g.pieces.length === 0) return false;
        // require at least one meaningful field in pieces
        const hasMeaning = g.pieces.some(pp => (pp.title && pp.title.length) || (pp.composer && pp.composer.length) || (pp.library_number && String(pp.library_number).length));
        if (!hasMeaning) return false;
        const key = String(g.titleKey || g.titleExample || '')
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    // Sort by severity (very-high, high, medium) and within each severity
    // sort by numeric library number when available (ascending). Fallback to
    // group size desc then titleExample.
    const severityOrder = { 'very-high': 0, 'high': 1, 'medium': 2 };

    function extractLibNum(g) {
        // Try titleKey of form 'libnum:NNN'
        try {
            if (g && g.titleKey && String(g.titleKey).startsWith('libnum:')) {
                const v = Number(String(g.titleKey).split(':')[1]);
                if (!Number.isNaN(v)) return v;
            }
            // fallback: first piece's library_number
            if (g && Array.isArray(g.pieces) && g.pieces.length > 0) {
                const ln = g.pieces[0].library_number || g.pieces[0].libraryNumber || g.pieces[0].lib_number;
                const v = Number(String(ln || '').trim());
                if (!Number.isNaN(v)) return v;
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // Partition by severity to preserve category ordering
    const buckets = { 'very-high': [], 'high': [], 'medium': [], 'other': [] };
    for (const g of filtered) {
        const k = g.severity && buckets[g.severity] ? g.severity : 'other';
        buckets[k].push(g);
    }

    for (const k of Object.keys(buckets)) {
        buckets[k].sort((a, b) => {
            const na = extractLibNum(a);
            const nb = extractLibNum(b);
            if (na !== null && nb !== null) return na - nb;
            if (na !== null) return -1;
            if (nb !== null) return 1;
            // fallback to group size desc
            if ((b.pieces.length - a.pieces.length) !== 0) return (b.pieces.length - a.pieces.length);
            return String(a.titleExample || '').localeCompare(String(b.titleExample || ''));
        });
    }

    // Recombine in severity order
    const combined = [...buckets['very-high'], ...buckets['high'], ...buckets['medium'], ...buckets['other']];

    // Heuristic: if result looks malformed (very many groups with little info), avoid returning them
    const MAX_GROUPS = 200; // safe upper-bound for single-page fallback
    const total = combined.length;
    const lowInfoCount = combined.filter(g => (!g.titleExample || !g.titleExample.trim()) || (Array.isArray(g.pieces) && g.pieces.length < 2)).length;
    // If more than 200 groups OR more than 80% are low-info, treat as not-yet-ready and return scanning state
    if (total > 200 || (total > 0 && (lowInfoCount / total) > 0.8)) {
        console.warn(`Duplicate scan returned suspiciously large/low-info payload (groups=${total}, lowInfo=${lowInfoCount}); returning empty scanning payload`);
        return { groups: [], cachedAt: payload.cachedAt || payload.cached_at || null, scanning: true, truncated: true };
    }

    // Apply pagination: opts.perPage / opts.page
    const perPage = Number(opts.perPage || opts.per_page) || 50;
    const page = Math.max(1, Number(opts.page) || 1);
    const totalPages = Math.max(1, Math.ceil(total / perPage));

    const start = (page - 1) * perPage;
    const end = start + perPage;
    const pageSlice = combined.slice(start, end);
    const truncated = total > perPage;
    out.groups = pageSlice.slice(0, MAX_GROUPS);
    out.cachedAt = payload.cachedAt || payload.cached_at || null;
    out.scanning = !!payload.scanning;
    if (truncated) out.truncated = true;
    // pagination metadata
    out.total = total;
    out.page = page;
    out.perPage = perPage;
    out.totalPages = totalPages;
    return out;
}

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

// GET /libraries/:libraryId/duplicates - scan a library for potential duplicate pieces
export async function findLibraryDuplicates(req, res) {
    try {
        const libraryId = req.params.libraryId;
        if (!libraryId) return res.status(400).json({ error: 'libraryId required' });
        const page = Number(req.query?.page) || 1;
        const perPage = Number(req.query?.per_page || req.query?.perPage) || undefined;
        const payload = await piecesService.findDuplicatesInLibraryCached(libraryId);
        // Debug: log payload shape for troubleshooting
        try {
            const rawGroups = payload?.groups ?? payload?.result ?? [];
            console.debug('[duplicates] payload type=%s groupsType=%s groupsCount=%d', typeof payload, typeof rawGroups, Array.isArray(rawGroups) ? rawGroups.length : 0);
            if (Array.isArray(rawGroups) && rawGroups.length > 0) {
                const sample = rawGroups.slice(0,3).map(g => ({ titleExample: g?.titleExample ?? g?.title_example, piecesLen: Array.isArray(g?.pieces) ? g.pieces.length : (Array.isArray(g?.result) ? g.result.length : (g && typeof g === 'string' ? g.length : 0)), severity: g?.severity }));
                console.debug('[duplicates] sample groups:', JSON.stringify(sample));
            }
        } catch (logErr) {
            console.warn('Failed to debug-log duplicates payload', logErr);
        }
        // normalize payload shape before returning to clients (supports pagination)
        return res.status(200).json(_serverNormalizePayload(payload, { page, perPage }));
    } catch (err) {
        console.error('findLibraryDuplicates error', err);
        res.status(500).json({ error: err.message });
    }
}

// Public: GET /libraries/public/:token/duplicates
export async function findLibraryDuplicatesPublic(req, res) {
    try {
        const token = req.params.token;
        if (!token) return res.status(400).json({ error: 'token required' });
        const lib = await libraryService.getLibraryByToken(token);
        if (!lib) return res.status(404).json({ error: 'Library not found' });
        const page = Number(req.query?.page) || 1;
        const perPage = Number(req.query?.per_page || req.query?.perPage) || undefined;
        const payload = await piecesService.findDuplicatesInLibraryCached(lib.id);
        try {
            const rawGroups = payload?.groups ?? payload?.result ?? [];
            console.debug('[duplicates:public] payload type=%s groupsType=%s groupsCount=%d', typeof payload, typeof rawGroups, Array.isArray(rawGroups) ? rawGroups.length : 0);
        } catch (logErr) {
            console.warn('Failed to debug-log public duplicates payload', logErr);
        }
        return res.status(200).json(_serverNormalizePayload(payload, { page, perPage }));
    } catch (err) {
        console.error('findLibraryDuplicatesPublic error', err);
        return res.status(500).json({ error: err.message });
    }
}

// Debug: return raw payload from the service without server-side normalization
export async function findLibraryDuplicatesRaw(req, res) {
    try {
        const libraryId = req.params.libraryId;
        if (!libraryId) return res.status(400).json({ error: 'libraryId required' });
        const payload = await piecesService.findDuplicatesInLibraryCached(libraryId);
        return res.status(200).json({ raw: payload });
    } catch (err) {
        console.error('findLibraryDuplicatesRaw error', err);
        return res.status(500).json({ error: err.message });
    }
}

// POST /libraries/:libraryId/duplicates/refresh
export async function refreshLibraryDuplicates(req, res) {
    try {
        const libraryId = req.params.libraryId;
        if (!libraryId) return res.status(400).json({ error: 'libraryId required' });
        const payload = await dupQueue.scheduleScan(libraryId);
        // scheduleScan returns immediate scanning state; include default pagination
        return res.status(202).json(_serverNormalizePayload(payload, { page: 1, perPage: 50 }));
    } catch (err) {
        console.error('refreshLibraryDuplicates error', err);
        return res.status(500).json({ error: err.message });
    }
}

