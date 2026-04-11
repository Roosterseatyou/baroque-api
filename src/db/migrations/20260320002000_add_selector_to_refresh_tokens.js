/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  return knex.schema.table("refresh_tokens", (table) => {
    table.string("selector").notNullable().unique();
    table.index("selector");
  });
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  return knex.schema.table("refresh_tokens", (table) => {
    table.dropIndex("selector");
    table.dropColumn("selector");
  });
}
