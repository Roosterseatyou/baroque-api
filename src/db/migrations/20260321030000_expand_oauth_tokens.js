/**
 * Make oauth token columns larger to store long Google tokens.
 * @param { import("knex").Knex } knex
 */
export async function up(knex) {
  return knex.schema.alterTable("oauth_info", (table) => {
    // change to text to accommodate long access/refresh tokens
    table.text("access_token").nullable().alter();
    table.text("refresh_token").nullable().alter();
  });
}

/**
 * Revert to varchar(255) - may truncate tokens; only for rollback in dev
 */
export async function down(knex) {
  return knex.schema.alterTable("oauth_info", (table) => {
    table.string("access_token").nullable().alter();
    table.string("refresh_token").nullable().alter();
  });
}
