import app from "./app.js";
import knex from "./config/knex.js";
import dotenv from "dotenv";
import * as dupQueue from "./services/dupQueue.service.js";
import { runFixCollectionsMetadata } from "../scripts/fix_collections_metadata.js";

dotenv.config();

const PORT = process.env.PORT || 3000;
const LISTEN_HOST = process.env.LISTEN_HOST || "0.0.0.0";
// If true, skip running migrations at startup
const SKIP_MIGRATIONS =
  String(process.env.SKIP_MIGRATIONS || "").toLowerCase() === "true";
// If true, start the server even when DB/migrations fail (useful for environments without DB)
const START_WITHOUT_DB =
  String(process.env.START_WITHOUT_DB || "").toLowerCase() === "true";

function getPathFromRegexp(re) {
  if (!re || !re.source) return "";
  return re.source
    .replace("\\/?", "/")
    .replace("(?=\\/|$)", "")
    .replace("^", "")
    .replace("$", "")
    .replace(/\\\//g, "/");
}

function resolveRouterStack(appOrRouter) {
  if (!appOrRouter) return null;
  // Common Express app shape
  if (appOrRouter._router && Array.isArray(appOrRouter._router.stack))
    return appOrRouter._router.stack;
  // Router exported directly (some code exports Router instance)
  if (Array.isArray(appOrRouter.stack)) return appOrRouter.stack;
  // Some wrapped router shapes (e.g., mounted middleware)
  if (
    appOrRouter.handle &&
    appOrRouter.handle.stack &&
    Array.isArray(appOrRouter.handle.stack)
  )
    return appOrRouter.handle.stack;
  if (appOrRouter.router && Array.isArray(appOrRouter.router.stack))
    return appOrRouter.router.stack;
  return null;
}

function printRoutes(appOrRouter) {
  const routerStack = resolveRouterStack(appOrRouter);
  if (!routerStack) {
    console.log(
      "No router stack found (app may not be an Express app/router). Attempting to show available keys for debugging:",
    );
    try {
      const keys = Object.keys(appOrRouter || {}).slice(0, 50);
      console.log(keys.join(", "));
    } catch (err) {
      // ignore
    }
    return;
  }

  const results = [];

  function traverse(stack, prefix = "") {
    stack.forEach((layer) => {
      // route registered directly
      if (layer.route && layer.route.path) {
        const methods = Object.keys(layer.route.methods || {})
          .map((m) => m.toUpperCase())
          .join(", ");
        const raw = `${prefix}${layer.route.path}`;
        const clean = raw.replace(/\/+/g, "/"); // collapse duplicate slashes
        results.push(`${methods} ${clean}`);
      } else if (
        layer.name === "router" &&
        layer.handle &&
        layer.handle.stack
      ) {
        // mounted router — extract mount path from layer.regexp or layer.path
        const mountPath = getPathFromRegexp(layer.regexp) || layer.path || "";
        const newPrefix = (prefix + mountPath).replace(/\/+/g, "/");
        traverse(layer.handle.stack, newPrefix);
      } else if (layer.path && layer.path !== "/") {
        // fallback for some router implementations
        const raw = `${prefix}${layer.path}`;
        results.push(raw.replace(/\/+/g, "/"));
      } else if (layer.handle && layer.handle.stack) {
        // nested router under `handle`
        traverse(layer.handle.stack, prefix);
      }
    });
  }

  traverse(routerStack, "");

  if (results.length === 0) {
    console.log("No routes found. Dumping router stack for debugging:");
    console.dir(routerStack, { depth: 4 });
  } else {
    results.sort().forEach((r) => console.log(r));
  }
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function migrateWithRetry({
  maxAttempts = 30,
  initialDelayMs = 2000,
} = {}) {
  let attempt = 0;
  let delay = initialDelayMs;
  while (attempt < maxAttempts) {
    attempt++;
    try {
      console.log(`Running Migrations... (attempt ${attempt}/${maxAttempts})`);
      await knex.migrate.latest();
      console.log("Migrations completed.");
      return;
    } catch (err) {
      console.warn(
        `Migration attempt ${attempt} failed: ${err && err.message ? err.message : err}`,
      );
      if (attempt >= maxAttempts) {
        throw err;
      }
      console.log(`Waiting ${delay}ms before retrying migrations...`);
      await sleep(delay);
      // exponential backoff with a cap
      delay = Math.min(delay * 2, 30000);
    }
  }
}

async function init() {
  try {
    // Optionally run maintenance scripts before startup if requested
    const RUN_SCRIPTS =
      String(process.env.RUN_SCRIPTS || "").toLowerCase() === "true";
    if (RUN_SCRIPTS) {
      console.log(
        "RUN_SCRIPTS=true — running maintenance scripts before startup",
      );
      try {
        await runFixCollectionsMetadata();
        console.log("Maintenance scripts completed successfully");
      } catch (e) {
        console.error("Maintenance scripts failed:", e);
        // Fail fast: do not start the server if the scripts were requested but failed
        process.exit(1);
      }
    }
    if (SKIP_MIGRATIONS) {
      console.log(
        "SKIP_MIGRATIONS=true — skipping database migrations at startup",
      );
    } else {
      try {
        await migrateWithRetry();
      } catch (mErr) {
        console.error(
          "Migrations failed after retries:",
          mErr && mErr.message ? mErr.message : mErr,
        );
        if (!START_WITHOUT_DB) {
          // If we require DB, exit with failure and print full stack
          console.error("Migrations failed after startup:", mErr);
          throw new Error(mErr && mErr.message ? mErr.message : String(mErr));
        }
        console.warn(
          "START_WITHOUT_DB=true — continuing startup despite failed migrations",
        );
      }
    }

    const server = app.listen(PORT, LISTEN_HOST, () => {
      console.log(`Server is running on ${LISTEN_HOST}:${PORT}`);
      printRoutes(app);
    });
    // Background poller for duplicate scan jobs can be run inline in this process
    // but CPU-heavy scans should run in a separate worker process to avoid
    // blocking the main HTTP server. To enable inline polling set RUN_DUP_QUEUE_INLINE=true
    const RUN_DUP_INLINE =
      String(process.env.RUN_DUP_QUEUE_INLINE || "").toLowerCase() === "true";

    // declare poller in outer scope so shutdown handler can reference it
    let poller = null;
    if (RUN_DUP_INLINE) {
      console.log(
        "Starting inline duplicate-scan poller (RUN_DUP_QUEUE_INLINE=true)",
      );
      const POLL_INTERVAL_MS = Number(process.env.DUP_QUEUE_POLL_MS || 30000);
      const DUP_QUEUE_LIMIT = Number(process.env.DUP_QUEUE_LIMIT || 5);
      poller = setInterval(async () => {
        try {
          const processed = await dupQueue.processPendingJobs({
            limit: DUP_QUEUE_LIMIT,
          });
          if (processed > 0)
            console.log(`Processed ${processed} duplicate scan job(s)`);
        } catch (e) {
          console.error("Error running duplicate scan job processor:", e);
        }
      }, POLL_INTERVAL_MS);
      // clear poller on shutdown (also allow immediate clears on signals)
      process.on("SIGINT", () => {
        if (poller) clearInterval(poller);
      });
      process.on("SIGTERM", () => {
        if (poller) clearInterval(poller);
      });
    } else {
      console.log(
        "Duplicate-scan poller not started in-process. Run `npm run worker` to start the separate worker.",
      );
    }
    const RUN_DELETE_INLINE =
      String(process.env.RUN_DELETION_INLINE || "").toLowerCase() === "true";
    if (RUN_DELETE_INLINE) {
      const POLL_INTERVAL_MS = Number(
        process.env.DELETION_WORKER_POLL_MS || 30000,
      );
      import("./worker/deletionWorker.js")
        .then((worker) => {
          // start inline without destroying the shared knex pool on stop
          const stop = worker.start({
            pollIntervalMs: POLL_INTERVAL_MS,
            destroyPoolOnStop: false,
          });
          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
        })
        .catch((err) => {
          console.error("Error starting deletion worker inline:", err);
        });
    } else {
      console.log(
        "Deletion worker not started in-process. Run `npm run worker:deletion` to start the separate worker.",
      );
    }
    const shutdown = async () => {
      console.log("Shutting down server...");
      server.close(async () => {});
      if (poller) clearInterval(poller);
      try {
        await knex.destroy();
      } catch (e) {
        /* ignore */
      }
      console.log("Server shut down complete.");
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } catch (error) {
    console.error("Error during server initialization:", error);
    process.exit(1);
  }
}

init();
