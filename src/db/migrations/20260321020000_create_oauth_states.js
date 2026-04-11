/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  return knex.schema.createTable("oauth_states", (table) => {
    table.string("state").primary();
    table.uuid("user_id").notNullable();
    table.string("redirect_to").notNullable().defaultTo("/");
    table.timestamp("created_at").defaultTo(knex.fn.now());
    table.timestamp("expires_at").nullable();
  });
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  return knex.schema.dropTable("oauth_states");
}
