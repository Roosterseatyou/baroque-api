#!/usr/bin/env node
/*
  Migration script: set organization_memberships.role = 'owner' for the organization creator.

  Strategy:
  - For each organization in the database, find a library_memberships row with role='owner' and that organization_id's default library.
  - Use the user_id from that library_membership as the creator (the code that originally created orgs inserted a library membership with role 'owner').
  - Update organization_memberships where organization_id matches and user_id matches, set role='owner'.

  Usage:
    node scripts/migrate-set-org-owners.js

  Notes:
  - This script runs using the project's knex configuration (src/config/knex.js).
  - It's safe to re-run; updates are idempotent.
*/

import db from '../src/config/knex.js';

async function migrate() {
  try {
    console.log('Starting migration: set organization_memberships.role = owner where applicable');

    // detect if updated_at column exists on organization_memberships
    let hasUpdatedAt = false;
    try {
      hasUpdatedAt = await db.schema.hasColumn('organization_memberships', 'updated_at');
      console.log(`organization_memberships.updated_at column present: ${hasUpdatedAt}`);
    } catch (e) {
      console.log('Could not determine presence of updated_at column; proceeding without it.');
      hasUpdatedAt = false;
    }

    // Get all organizations
    const orgs = await db('organizations').select('id');
    console.log(`Found ${orgs.length} organizations`);

    let totalUpdated = 0;

    for (const org of orgs) {
      const orgId = org.id;

      // Find any library owned by someone in this organization. Prefer the earliest created library for the org.
      const lib = await db('libraries')
        .where({ organization_id: orgId })
        .orderBy('created_at', 'asc')
        .first();

      if (!lib) {
        console.log(`  org ${orgId}: no libraries found, skipping`);
        continue;
      }

      // Find a library_membership for that library with role='owner'
      const libMembership = await db('library_memberships')
        .where({ library_id: lib.id, role: 'owner' })
        .first();

      if (!libMembership) {
        console.log(`  org ${orgId}: no library owner membership for library ${lib.id}, skipping`);
        continue;
      }

      const userId = libMembership.user_id;

      // Update organization_memberships for that user/org to role 'owner'
      let updateCount = 0;
      try {
        if (hasUpdatedAt) {
          updateCount = await db('organization_memberships')
            .where({ organization_id: orgId, user_id: userId })
            .update({ role: 'owner', updated_at: db.fn.now() });
        } else {
          updateCount = await db('organization_memberships')
            .where({ organization_id: orgId, user_id: userId })
            .update({ role: 'owner' });
        }
      } catch (err) {
        console.error(`  org ${orgId}: failed to update organization_memberships for user ${userId}:`, err.message || err);
        continue;
      }

      if (updateCount > 0) {
        console.log(`  org ${orgId}: set ${updateCount} organization_membership(s) for user ${userId} -> owner`);
        totalUpdated += updateCount;
      } else {
        // If no row existed, optionally insert one. We will not insert by default, but we can log.
        console.log(`  org ${orgId}: no organization_membership row for user ${userId} (consider inserting if desired)`);
      }
    }

    console.log(`Migration complete. Total organization_memberships updated: ${totalUpdated}`);
    await db.destroy();
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    try { await db.destroy(); } catch(e){}
    process.exit(1);
  }
}

migrate();
