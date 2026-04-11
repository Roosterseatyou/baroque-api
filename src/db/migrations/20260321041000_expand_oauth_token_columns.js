/**
 * Expand oauth_info access_token and refresh_token to TEXT to avoid truncation when Google returns long tokens.
 * @param { import("knex").Knex } knex
 */
export async function up(knex) {
  return knex.schema.alterTable("oauth_info", (table) => {
    table.text("access_token").nullable().alter();
    table.text("refresh_token").nullable().alter();
  });
}

export async function down(knex) {
  return knex.schema.alterTable("oauth_info", (table) => {
    // revert to varchar(255) if that was the previous type — adjust if your schema differs
    table.string("access_token", 255).nullable().alter();
    table.string("refresh_token", 255).nullable().alter();
  });
}
