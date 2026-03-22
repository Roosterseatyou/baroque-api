/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
    return knex.schema.createTable('tags', table => {
        table.uuid('id').primary();
        table.uuid('library_id').notNullable();
        table.foreign('library_id').references('id').inTable('libraries').onDelete('CASCADE');
        table.string('name').notNullable();
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.timestamp('updated_at').defaultTo(knex.fn.now());
        table.unique(['library_id', 'name']);
    });
};

export async function down(knex) {
    return knex.schema.dropTable('tags');
};
