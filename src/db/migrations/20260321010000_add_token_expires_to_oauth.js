/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  return knex.schema.alterTable("oauth_info", (table) => {
    table.timestamp("token_expires_at").nullable();
  });
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  return knex.schema.alterTable("oauth_info", (table) => {
    table.dropColumn("token_expires_at");
  });
}
