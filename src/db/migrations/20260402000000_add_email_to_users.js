/**
 * Add email column to users table if it does not exist.
 * This migration is idempotent and safe to run on databases that already have the column.
 */
export async function up(knex) {
  const has = await knex.schema.hasColumn("users", "email");
  if (!has) {
    await knex.schema.alterTable("users", (table) => {
      table.string("email").nullable().unique();
    });
  }
}

export async function down(knex) {
  const has = await knex.schema.hasColumn("users", "email");
  if (has) {
    await knex.schema.alterTable("users", (table) => {
      table.dropColumn("email");
    });
  }
}
