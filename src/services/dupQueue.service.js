import db from "../config/knex.js";
import * as piecesService from "./pieces.service.js";

// Schedule a duplicate scan job for a library. If a recent job exists (done within TTL), returns that cached result.
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function scheduleScan(libraryId) {
  if (!libraryId) return { groups: [], cachedAt: null, scanning: false };

  // Check for most recent job for this library
  const recent = await db("duplicate_scan_jobs")
    .where({ library_id: libraryId })
    .orderBy("created_at", "desc")
    .first();

  const now = Date.now();
  if (recent) {
    // If recent job is done and still fresh, return cached
    if (
      recent.status === "done" &&
      recent.cached_at &&
      now - Number(recent.cached_at) < CACHE_TTL_MS
    ) {
      return {
        groups: recent.result ? safeParseResult(recent.result) : [],
        cachedAt: recent.cached_at,
        scanning: false,
      };
    }
    // If a job is pending or running, return its result (may be null) and indicate scanning
    if (recent.status === "pending" || recent.status === "running") {
      return {
        groups: recent.result ? safeParseResult(recent.result) : [],
        cachedAt: recent.cached_at || null,
        scanning: true,
      };
    }
  }

  // Otherwise, insert a new pending job
  await db("duplicate_scan_jobs").insert({
    library_id: libraryId,
    status: "pending",
    attempts: 0,
    created_at: db.fn.now(),
    updated_at: db.fn.now(),
  });
  return {
    groups: recent?.result ? safeParseResult(recent.result) : [],
    cachedAt: recent?.cached_at || null,
    scanning: true,
  };
}

// Process pending jobs. This should be run by a background worker (or periodically from server startup).
export async function processPendingJobs({ limit = 5 } = {}) {
  // maximum attempts before marking a job as permanently failed
  const MAX_ATTEMPTS = Number(process.env.DUP_MAX_ATTEMPTS || 3);

  // Recover stale 'running' jobs that might have been left by a timed-out worker
  try {
    const WORKER_TIMEOUT_MS = Number(
      process.env.DUP_WORKER_TIMEOUT_MS || 5 * 60 * 1000,
    );
    const staleCutoff = new Date(Date.now() - WORKER_TIMEOUT_MS - 60000); // extra 60s buffer
    const staleRunning = await db("duplicate_scan_jobs")
      .where({ status: "running" })
      .andWhere("started_at", "<", staleCutoff)
      .select();
    for (const r of staleRunning) {
      const attemptsNow = Number(r.attempts || 0);
      if (attemptsNow >= MAX_ATTEMPTS) {
        try {
          await db("duplicate_scan_jobs")
            .where({ id: r.id })
            .update({
              status: "failed",
              last_error: "stale-running-exceeded-attempts",
              updated_at: db.fn.now(),
            });
          console.warn(
            `Duplicate scan job id=${r.id} marked failed due to stale running state (attempts=${attemptsNow})`,
          );
        } catch (e) {
          console.error("Failed to mark stale running job as failed", r.id, e);
        }
      } else {
        try {
          await db("duplicate_scan_jobs")
            .where({ id: r.id })
            .update({ status: "pending", updated_at: db.fn.now() });
          console.warn(
            `Requeued stale running duplicate_scan_job id=${r.id} for retry (attempts=${attemptsNow})`,
          );
        } catch (e) {
          console.error("Failed to requeue stale running job", r.id, e);
        }
      }
    }
  } catch (e) {
    console.warn("Failed to recover stale running duplicate scan jobs", e);
  }

  // fetch pending jobs
  const jobs = await db("duplicate_scan_jobs")
    .whereIn("status", ["pending"])
    .orderBy("created_at", "asc")
    .limit(limit);

  for (const j of jobs) {
    // mark as running and increment attempts (attempt count represents attempts started)
    await db("duplicate_scan_jobs")
      .where({ id: j.id, status: "pending" })
      .update({
        status: "running",
        started_at: db.fn.now(),
        attempts: Number(j.attempts || 0) + 1,
        updated_at: db.fn.now(),
      });
    try {
      // Use worker_threads if available to avoid blocking main thread when run inline
      let groups;
      let WorkerImpl = null;
      try {
        const mod = await import("worker_threads");
        WorkerImpl = mod.Worker;
      } catch (e) {
        WorkerImpl = null;
      }

      if (WorkerImpl) {
        // spawn a worker to perform the expensive operation
        groups = await new Promise((resolve, reject) => {
          const w = new WorkerImpl(
            new URL("../worker/findDuplicatesWorker.js", import.meta.url),
            { workerData: { libraryId: j.library_id } },
          );
          const timeout = Number(
            process.env.DUP_WORKER_TIMEOUT_MS || 5 * 60 * 1000,
          );
          let timer = setTimeout(() => {
            // try to terminate the worker and reject with timeout
            try {
              w.terminate();
            } catch (e) {
              /* ignore */
            }
            // prevent any later handlers from running and clean up resources
            settled = true;
            try {
              cleanUp();
            } catch (e) {
              /* ignore cleanup errors */
            }
            reject(new Error("Worker timed out"));
          }, timeout);
          let settled = false;
          const cleanUp = () => {
            try {
              if (timer) {
                clearTimeout(timer);
                timer = null;
              }
            } catch (e) {
              /* ignore */
            }
            // remove listeners to avoid them firing after we've already settled
            try {
              w.removeAllListeners && w.removeAllListeners("message");
            } catch (e) {
              /* ignore */
            }
            try {
              w.removeAllListeners && w.removeAllListeners("error");
            } catch (e) {
              /* ignore */
            }
            try {
              w.removeAllListeners && w.removeAllListeners("exit");
            } catch (e) {
              /* ignore */
            }
          };

          w.on("message", (m) => {
            if (settled) return;
            settled = true;
            cleanUp();
            if (m && m.success) resolve(m.groups);
            else reject(new Error(m && m.error ? m.error : "Worker failed"));
          });
          w.on("error", (err) => {
            if (settled) return;
            settled = true;
            cleanUp();
            reject(err);
          });
          w.on("exit", (code) => {
            if (settled) return;
            settled = true;
            cleanUp();
            if (code === 0) {
              // worker exited cleanly but did not send a message; treat as failure
              reject(new Error("Worker exited without result"));
            } else {
              reject(new Error(`Worker exited with code ${code}`));
            }
          });
        });
      } else {
        groups = await piecesService.findDuplicatesInLibrary(j.library_id);
      }
      // sanitize groups before persisting to DB
      const sanitized = sanitizeGroups(groups);
      await db("duplicate_scan_jobs")
        .where({ id: j.id })
        .update({
          status: "done",
          result: JSON.stringify(sanitized),
          cached_at: Date.now(),
          finished_at: db.fn.now(),
          updated_at: db.fn.now(),
        });
    } catch (err) {
      console.error("Failed processing duplicate scan job", j.id, err);
      // If the job has attempts remaining, requeue it as 'pending' to retry later.
      const attemptsNow = Number(j.attempts || 0) + 1;
      const lastError = String(err && err.message ? err.message : err);
      if (attemptsNow < MAX_ATTEMPTS) {
        // Requeue for another attempt
        try {
          await db("duplicate_scan_jobs")
            .where({ id: j.id })
            .update({
              status: "pending",
              last_error: lastError,
              updated_at: db.fn.now(),
            });
          console.warn(
            `Requeued duplicate_scan_job id=${j.id} for retry (attempt ${attemptsNow}/${MAX_ATTEMPTS})`,
          );
        } catch (updErr) {
          console.error("Failed to requeue duplicate scan job", j.id, updErr);
          // if requeue failed, mark as failed
          await db("duplicate_scan_jobs")
            .where({ id: j.id })
            .update({
              status: "failed",
              last_error: `${lastError}; requeue failed: ${updErr && updErr.message ? updErr.message : updErr}`,
              updated_at: db.fn.now(),
            });
        }
      } else {
        // Exhausted attempts: mark as permanently failed
        try {
          await db("duplicate_scan_jobs")
            .where({ id: j.id })
            .update({
              status: "failed",
              last_error: lastError,
              updated_at: db.fn.now(),
            });
          console.warn(
            `Duplicate scan job id=${j.id} marked failed after ${attemptsNow} attempts`,
          );
        } catch (updErr) {
          console.error(
            "Failed to mark duplicate scan job as failed",
            j.id,
            updErr,
          );
        }
      }
    }
  }

  return jobs.length;
}

// Utility to get latest job status/result for a library
export async function getLatestForLibrary(libraryId) {
  const job = await db("duplicate_scan_jobs")
    .where({ library_id: libraryId })
    .orderBy("created_at", "desc")
    .first();
  if (!job) return { groups: [], cachedAt: null, scanning: false };
  if (job.status === "pending" || job.status === "running")
    return {
      groups: job.result ? safeParseResult(job.result) : [],
      cachedAt: job.cached_at || null,
      scanning: true,
    };
  // For 'failed' or any other terminal status, return cached result (if any) and indicate not scanning
  return {
    groups: job.result ? safeParseResult(job.result) : [],
    cachedAt: job.cached_at || null,
    scanning: false,
  };
}

function safeParseResult(r) {
  if (!r) return [];
  // If it's already an array, return as-is
  if (Array.isArray(r)) return r;
  // If DB driver returned an object/JSON type, return it (could be array-like)
  if (typeof r === "object") return r;
  // If it's a string, attempt to parse JSON
  if (typeof r === "string") {
    try {
      return JSON.parse(r);
    } catch (e) {
      return [];
    }
  }
  return [];
}

function sanitizeGroups(groups) {
  if (!groups || !Array.isArray(groups)) return [];
  const out = [];
  for (const g of groups) {
    if (!g || typeof g !== "object") continue;
    const piecesRaw = g.pieces || g.result || [];
    let pieces = [];
    if (typeof piecesRaw === "string") {
      try {
        pieces = JSON.parse(piecesRaw);
      } catch (e) {
        pieces = [];
      }
    } else if (Array.isArray(piecesRaw)) pieces = piecesRaw;
    else if (typeof piecesRaw === "object") pieces = Object.values(piecesRaw);
    else pieces = [];

    // coerce piece fields
    pieces = pieces
      .map((p) => {
        if (!p || typeof p !== "object") return null;
        return {
          id: p.id || p.ID || null,
          title: (p.title || p.name || "").toString().trim(),
          composer: (p.composer || "").toString().trim(),
          arranger: (p.arranger || "").toString().trim(),
          publisher: (p.publisher || "").toString().trim(),
          instrumentation: (p.instrumentation || "").toString().trim(),
          library_number:
            p.library_number || p.libraryNumber || p.lib_number || null,
        };
      })
      .filter(Boolean);

    // remove pieces lacking title/composer/libnum
    pieces = pieces.filter(
      (pp) =>
        (pp.title && pp.title.length) ||
        (pp.composer && pp.composer.length) ||
        (pp.library_number && String(pp.library_number).length),
    );

    // dedupe pieces
    const seen = new Set();
    pieces = pieces.filter((pp) => {
      const key = pp.id || `libnum:${pp.library_number}` || JSON.stringify(pp);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    if (!pieces || pieces.length < 2) continue;
    out.push({
      titleKey:
        g.titleKey || g.title_example || (pieces[0] ? pieces[0].title : ""),
      titleExample:
        g.titleExample || g.title_example || (pieces[0] ? pieces[0].title : ""),
      severity: g.severity || "medium",
      pieces,
    });
  }
  return out;
}
