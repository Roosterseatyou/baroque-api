/**
 * Add quantity column to pieces table
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  // default to 1 for existing rows
  return knex.schema.alterTable("pieces", (table) => {
    table.integer("quantity").notNullable().defaultTo(1);
  });
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  return knex.schema.alterTable("pieces", (table) => {
    table.dropColumn("quantity");
  });
}
