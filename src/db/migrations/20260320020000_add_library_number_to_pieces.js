/**
 * Add library_number column to pieces
 */

/** @param { import("knex").Knex } knex */
export async function up(knex) {
  return knex.schema.alterTable("pieces", (table) => {
    table.string("library_number").nullable();
  });
}

/** @param { import("knex").Knex } knex */
export async function down(knex) {
  return knex.schema.alterTable("pieces", (table) => {
    table.dropColumn("library_number");
  });
}
