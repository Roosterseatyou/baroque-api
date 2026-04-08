#!/usr/bin/env node
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import knex from '../config/knex.js';
import * as orgsService from '../services/orgs.service.js';

dotenv.config();

const DEFAULT_POLL_INTERVAL_MS = Number(process.env.DELETION_WORKER_POLL_MS || 60 * 1000);

async function processOrganizations() {
  // Find organizations scheduled for deletion whose time has passed
  const now = new Date();
  const rows = await knex('organizations').whereNotNull('deletion_scheduled_at').andWhere('deletion_scheduled_at', '<=', now).select('id');
  for (const r of rows) {
    try {
      console.log('[deletionWorker] hard-deleting organization', r.id);
      await orgsService.hardDeleteOrganization(r.id, null, null);
      // clear scheduled deletion if still present (hardDeleteOrganization deletes row so this is just safety)
      try { await knex('organizations').where({ id: r.id }).update({ deletion_scheduled_at: null }); } catch (e) {}
      console.log('[deletionWorker] organization deleted', r.id);
    } catch (e) {
      console.error('[deletionWorker] failed to delete organization', r.id, e);
    }
  }
}

async function processUsers() {
  // Find users scheduled for deletion whose time has passed
  const now = new Date();
  const rows = await knex('users').whereNotNull('deletion_scheduled_at').andWhere('deletion_scheduled_at', '<=', now).select('id');
  for (const r of rows) {
    try {
      console.log('[deletionWorker] hard-deleting user', r.id);
      // For users, we will hard-delete by running organization hard-deletes where owner was this user (if any) and then remove user row
      // Use a transaction to be safe
      await knex.transaction(async (trx) => {
        // Find orgs still owned by this user
        const ownerRows = await trx('organization_memberships').where({ user_id: r.id, role: 'owner' }).select('organization_id');
        for (const or of ownerRows) {
          try {
            await orgsService.hardDeleteOrganization(or.organization_id, r.id, trx);
          } catch (e) {
            console.error('[deletionWorker] failed to hard-delete org', or.organization_id, e);
          }
        }

        // delete memberships
        await trx('organization_memberships').where({ user_id: r.id }).del();
        await trx('library_memberships').where({ user_id: r.id }).del();
        // delete oauth, tokens, states
        try { await trx('oauth_info').where({ user_id: r.id }).del(); } catch (e) {}
        try { await trx('refresh_tokens').where({ user_id: r.id }).del(); } catch (e) {}
        try { await trx('oauth_states').where({ user_id: r.id }).del(); } catch (e) {}

        // delete user row
        await trx('users').where({ id: r.id }).del();
      });
      console.log('[deletionWorker] user deleted', r.id);
    } catch (e) {
      console.error('[deletionWorker] failed to delete user', r.id, e);
    }
  }
}

async function runOnce() {
  await processOrganizations();
  await processUsers();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Start a background loop; returns a stop function that will stop the loop and wait for shutdown.
function start({ pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, destroyPoolOnStop = true } = {}) {
  let stopped = false;

  const stop = async () => { stopped = true; };

  (async () => {
    console.log('Deletion worker started, polling every', pollIntervalMs, 'ms');
    while (!stopped) {
      try {
        await runOnce();
      } catch (e) {
        console.error('Deletion worker error:', e);
      }
      // wait or break early if stopped
      let waited = 0;
      while (!stopped && waited < pollIntervalMs) {
        const toWait = Math.min(1000, pollIntervalMs - waited);
        // small sleep so we can respond to stop quickly
        // eslint-disable-next-line no-await-in-loop
        await sleep(toWait);
        waited += toWait;
      }
    }
    if (destroyPoolOnStop) {
      try { await knex.destroy(); } catch (e) {}
    }
    console.log('Deletion worker shutting down');
  })();

  return stop;
}

// If executed directly, start the worker and wire shutdown signals
const isDirectRun = process.argv && process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  const stop = start();
  process.on('SIGINT', () => { console.log('SIGINT received, stopping worker'); stop(); });
  process.on('SIGTERM', () => { console.log('SIGTERM received, stopping worker'); stop(); });
}

export { runOnce, start };

