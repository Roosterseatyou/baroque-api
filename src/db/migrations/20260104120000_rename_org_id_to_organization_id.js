/**
 * Migration: rename libraries.org_id -> libraries.organization_id
 *
 * Strategy (safe for MySQL/Postgres):
 * 1. Add a new nullable column `organization_id` (uuid/char(36)).
 * 2. Copy values from `org_id` into `organization_id`.
 * 3. Drop foreign key constraint on `org_id` (if any) and drop `org_id` column.
 * 4. Alter `organization_id` to NOT NULL and add a foreign key constraint to organizations.id.
 */

export async function up(knex) {
  // 1) add new column (nullable for now)
  await knex.schema.alterTable("libraries", (table) => {
    table.uuid("organization_id");
  });

  // 2) copy values from org_id to organization_id
  // Use raw so it works for MySQL/Postgres
  await knex.raw("UPDATE libraries SET organization_id = org_id");

  // 3) drop foreign key on org_id if it exists, then drop the column
  // This inspects information_schema to find the constraint name (MySQL) or uses pg_catalog for Postgres
  // MySQL path
  try {
    const fkRows = await knex.raw(
      `SELECT CONSTRAINT_NAME as constraint_name
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'libraries' AND COLUMN_NAME = 'org_id' AND REFERENCED_TABLE_NAME = 'organizations'`,
    );
    const rows = fkRows[0] || fkRows; // knex mysql returns [rows, fields]
    if (rows && rows.length) {
      const constraintName = rows[0].constraint_name;
      await knex.raw(
        `ALTER TABLE libraries DROP FOREIGN KEY \`${constraintName}\``,
      );
    }
  } catch (e) {
    // Not MySQL or no foreign key found, ignore and continue
  }

  // Postgres path (in case project uses Postgres)
  try {
    const pgFk = await knex.raw(
      `SELECT conname as constraint_name
       FROM pg_constraint c
       JOIN pg_class t ON c.conrelid = t.oid
       JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
       WHERE t.relname = 'libraries' AND a.attname = 'org_id'`,
    );
    const rowsPg = pgFk.rows || pgFk[0];
    if (rowsPg && rowsPg.length) {
      const constraintName = rowsPg[0].constraint_name;
      await knex.raw(
        `ALTER TABLE libraries DROP CONSTRAINT \"${constraintName}\"`,
      );
    }
  } catch (e) {
    // Not Postgres or no constraint found
  }

  // Try to drop index on org_id if it exists (MySQL will error if not exists, so wrap)
  try {
    await knex.raw("ALTER TABLE libraries DROP COLUMN org_id");
  } catch (e) {
    // If drop column failed (maybe no org_id), ignore
  }

  // 4) make organization_id NOT NULL and add foreign key
  try {
    await knex.schema.alterTable("libraries", (table) => {
      table.uuid("organization_id").notNullable().alter();
    });
  } catch (e) {
    // Some DBs don't support alter() in this way; fallback to raw for MySQL
    try {
      await knex.raw(
        "ALTER TABLE libraries MODIFY organization_id CHAR(36) NOT NULL",
      );
    } catch (e2) {
      // ignore -- column may already be not null
    }
  }

  // Add foreign key
  await knex.schema.alterTable("libraries", (table) => {
    table
      .foreign("organization_id")
      .references("id")
      .inTable("organizations")
      .onDelete("CASCADE");
  });
}

export async function down(knex) {
  // reverse: add org_id, copy back, drop organization_id FK & column, add org_id fk
  await knex.schema.alterTable("libraries", (table) => {
    table.uuid("org_id");
  });

  await knex.raw("UPDATE libraries SET org_id = organization_id");

  // drop foreign key on organization_id
  try {
    const fkRows = await knex.raw(
      `SELECT CONSTRAINT_NAME as constraint_name
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'libraries' AND COLUMN_NAME = 'organization_id' AND REFERENCED_TABLE_NAME = 'organizations'`,
    );
    const rows = fkRows[0] || fkRows;
    if (rows && rows.length) {
      const constraintName = rows[0].constraint_name;
      await knex.raw(
        `ALTER TABLE libraries DROP FOREIGN KEY \`${constraintName}\``,
      );
    }
  } catch (e) {
    // ignore
  }

  try {
    await knex.raw("ALTER TABLE libraries DROP COLUMN organization_id");
  } catch (e) {
    // ignore
  }

  // add foreign key on org_id
  await knex.schema.alterTable("libraries", (table) => {
    table
      .foreign("org_id")
      .references("id")
      .inTable("organizations")
      .onDelete("CASCADE");
  });
}
