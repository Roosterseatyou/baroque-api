/**
 * Add username + 4-digit discriminator to users, backfill from email, then drop email.
 * - Adds nullable columns `username` and `discriminator`
 * - Backfills values derived from existing email local-part with random 4-digit discriminator ensuring uniqueness
 * - Marks columns NOT NULL and adds unique constraint on (username, discriminator)
 * - Drops the `email` column
 *
 * Down migration restores `email` (nullable) and removes username/discriminator and index.
 */
export async function up(knex) {
  // 1) Add new nullable columns
  await knex.schema.alterTable('users', (table) => {
    table.string('username', 50);
    table.string('discriminator', 4);
  });

  // 2) Backfill usernames and discriminators from existing emails
  const users = await knex('users').select('id', 'email');

  // helper to sanitize local part into a reasonable username base
  function sanitizeLocalPart(s) {
    if (!s) return 'user';
    // lowercase, allow a-z0-9._- and collapse other chars
    const t = String(s).toLowerCase().replace(/[^a-z0-9._-]/g, '');
    return t.length ? t.slice(0, 30) : 'user';
  }

  for (const u of users) {
    const local = sanitizeLocalPart((u.email || '').split('@')[0]);
    let base = local || 'user';
    let chosen = false;
    // try a number of attempts to find a free discriminator
    for (let attempt = 0; attempt < 200; attempt++) {
      const disc = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
      // check existence
      // note: use .first() to keep query minimal
      // make sure we don't collide with already-backfilled rows
      // (this query checks current DB state)
      // eslint-disable-next-line no-await-in-loop
      const exists = await knex('users').where({ username: base, discriminator: disc }).first();
      if (!exists) {
        // update this user
        // eslint-disable-next-line no-await-in-loop
        await knex('users').where({ id: u.id }).update({ username: base, discriminator: disc });
        chosen = true;
        break;
      }
    }
    if (!chosen) {
      // As a fallback, append a short suffix to base and use 0000
      // eslint-disable-next-line no-await-in-loop
      let suffix = 1;
      while (true) {
        const candidate = `${base}${suffix}`.slice(0, 50);
        // eslint-disable-next-line no-await-in-loop
        const exists2 = await knex('users').where({ username: candidate, discriminator: '0000' }).first();
        if (!exists2) {
          // eslint-disable-next-line no-await-in-loop
          await knex('users').where({ id: u.id }).update({ username: candidate, discriminator: '0000' });
          break;
        }
        suffix += 1;
      }
    }
  }

  // 3) Make columns NOT NULL and add unique constraint on (username, discriminator)
  // Use raw SQL to ALTER columns to NOT NULL for broad DB support
  await knex.schema.alterTable('users', (table) => {
    table.string('username', 50).notNullable().alter();
    table.string('discriminator', 4).notNullable().alter();
  });

  // Create unique index name explicitly
  await knex.schema.alterTable('users', (table) => {
    table.unique(['username', 'discriminator'], 'users_username_discriminator_unique');
  });

  // 4) Drop email column (we assume no other tables reference email as PK)
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('email');
  });
}

export async function down(knex) {
  // 1) Add back email column as nullable
  await knex.schema.alterTable('users', (table) => {
    table.string('email');
  });

  // Note: We cannot reconstruct original emails. Down migration leaves email NULL.

  // 2) Drop unique index and remove username/discriminator columns
  // Postgres/Knex: drop index via raw if necessary
  try {
    await knex.schema.alterTable('users', (table) => {
      table.dropUnique(['username', 'discriminator'], 'users_username_discriminator_unique');
    });
  } catch (e) {
    // ignore if index does not exist
  }

  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('username');
    table.dropColumn('discriminator');
  });
}

