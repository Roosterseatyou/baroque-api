import db from '../config/knex.js';
import * as piecesService from './pieces.service.js';

// Schedule a duplicate scan job for a library. If a recent job exists (done within TTL), returns that cached result.
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function scheduleScan(libraryId) {
  if (!libraryId) return { groups: [], cachedAt: null, scanning: false };

  // Check for most recent job for this library
  const recent = await db('duplicate_scan_jobs')
    .where({ library_id: libraryId })
    .orderBy('created_at', 'desc')
    .first();

  const now = Date.now();
  if (recent) {
    // If recent job is done and still fresh, return cached
    if (recent.status === 'done' && recent.cached_at && (now - Number(recent.cached_at) < CACHE_TTL_MS)) {
      return { groups: recent.result ? safeParseResult(recent.result) : [], cachedAt: recent.cached_at, scanning: false };
    }
    // If a job is pending or running, return its result (may be null) and indicate scanning
    if (recent.status === 'pending' || recent.status === 'running') {
      return { groups: recent.result ? safeParseResult(recent.result) : [], cachedAt: recent.cached_at || null, scanning: true };
    }
  }

  // Otherwise, insert a new pending job
  await db('duplicate_scan_jobs').insert({ library_id: libraryId, status: 'pending', attempts: 0, created_at: db.fn.now(), updated_at: db.fn.now() });
  return { groups: recent?.result ? safeParseResult(recent.result) : [], cachedAt: recent?.cached_at || null, scanning: true };
}

// Process pending jobs. This should be run by a background worker (or periodically from server startup).
export async function processPendingJobs({ limit = 5 } = {}) {
  // fetch pending jobs
  const jobs = await db('duplicate_scan_jobs')
    .whereIn('status', ['pending'])
    .orderBy('created_at', 'asc')
    .limit(limit);

  for (const j of jobs) {
    // mark as running
    await db('duplicate_scan_jobs').where({ id: j.id, status: 'pending' }).update({ status: 'running', started_at: db.fn.now(), attempts: j.attempts + 1, updated_at: db.fn.now() });
    try {
      const groups = await piecesService.findDuplicatesInLibrary(j.library_id);
      // sanitize groups before persisting to DB
      const sanitized = sanitizeGroups(groups);
      await db('duplicate_scan_jobs').where({ id: j.id }).update({ status: 'done', result: JSON.stringify(sanitized), cached_at: Date.now(), finished_at: db.fn.now(), updated_at: db.fn.now() });
    } catch (err) {
      console.error('Failed processing duplicate scan job', j.id, err);
      await db('duplicate_scan_jobs').where({ id: j.id }).update({ status: 'failed', last_error: String(err && err.message ? err.message : err), updated_at: db.fn.now() });
    }
  }

  return jobs.length;
}

// Utility to get latest job status/result for a library
export async function getLatestForLibrary(libraryId) {
  const job = await db('duplicate_scan_jobs').where({ library_id: libraryId }).orderBy('created_at', 'desc').first();
  if (!job) return { groups: [], cachedAt: null, scanning: false };
  if (job.status === 'pending' || job.status === 'running') return { groups: job.result ? safeParseResult(job.result) : [], cachedAt: job.cached_at || null, scanning: true };
  return { groups: job.result ? safeParseResult(job.result) : [], cachedAt: job.cached_at || null, scanning: job.status !== 'done' };
}

function safeParseResult(r) {
  if (!r) return [];
  // If it's already an array, return as-is
  if (Array.isArray(r)) return r;
  // If DB driver returned an object/JSON type, return it (could be array-like)
  if (typeof r === 'object') return r;
  // If it's a string, attempt to parse JSON
  if (typeof r === 'string') {
    try { return JSON.parse(r); } catch (e) { return [] }
  }
  return [];
}

function sanitizeGroups(groups) {
  if (!groups || !Array.isArray(groups)) return [];
  const out = [];
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue;
    const piecesRaw = g.pieces || g.result || [];
    let pieces = [];
    if (typeof piecesRaw === 'string') {
      try { pieces = JSON.parse(piecesRaw) } catch (e) { pieces = [] }
    } else if (Array.isArray(piecesRaw)) pieces = piecesRaw
    else if (typeof piecesRaw === 'object') pieces = Object.values(piecesRaw)
    else pieces = [];

    // coerce piece fields
    pieces = pieces.map(p => {
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

    // remove pieces lacking title/composer/libnum
    pieces = pieces.filter(pp => (pp.title && pp.title.length) || (pp.composer && pp.composer.length) || (pp.library_number && String(pp.library_number).length));

    // dedupe pieces
    const seen = new Set();
    pieces = pieces.filter(pp => {
      const key = pp.id || (`libnum:${pp.library_number}`) || JSON.stringify(pp);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (!pieces || pieces.length < 2) continue;
    out.push({ titleKey: g.titleKey || g.title_example || (pieces[0] ? pieces[0].title : ''), titleExample: g.titleExample || g.title_example || (pieces[0] ? pieces[0].title : ''), severity: g.severity || 'medium', pieces });
  }
  return out;
}

