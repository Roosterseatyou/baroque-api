/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  return knex.schema.alterTable('piece_comments', table => {
    table.uuid('parent_id').nullable();
    table.foreign('parent_id').references('id').inTable('piece_comments').onDelete('CASCADE');
  });
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  return knex.schema.alterTable('piece_comments', table => {
    table.dropForeign(['parent_id']);
    table.dropColumn('parent_id');
  });
}
