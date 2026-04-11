/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  return knex.schema.table("refresh_tokens", (table) => {
    table.boolean("revoked").defaultTo(false);
    table.timestamp("revoked_at").nullable();
    table.string("revoked_reason").nullable();
  });
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  return knex.schema.table("refresh_tokens", (table) => {
    table.dropColumn("revoked_reason");
    table.dropColumn("revoked_at");
    table.dropColumn("revoked");
  });
}
