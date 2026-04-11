#!/usr/bin/env node
import dotenv from "dotenv";
import * as dupQueue from "../services/dupQueue.service.js";
import knex from "../config/knex.js";

dotenv.config();

const POLL_INTERVAL_MS = Number(process.env.DUP_QUEUE_POLL_MS || 30000);
let shouldStop = false;

process.on("SIGINT", () => {
  shouldStop = true;
});
process.on("SIGTERM", () => {
  shouldStop = true;
});

async function loop() {
  console.log(
    "Duplicate scan worker started, polling every",
    POLL_INTERVAL_MS,
    "ms",
  );
  while (!shouldStop) {
    try {
      const processed = await dupQueue.processPendingJobs({ limit: 5 });
      if (processed > 0)
        console.log(`Processed ${processed} duplicate scan job(s)`);
    } catch (e) {
      console.error("Worker error processing jobs:", e);
    }
    // sleep
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  try {
    await knex.destroy();
  } catch (e) {
    /* ignore */
  }
  console.log("Duplicate scan worker shutting down");
  process.exit(0);
}

loop();
