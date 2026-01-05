/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
    return knex.schema.createTable('pieces', table => {
        table.uuid('id').primary();
        table.uuid('library_id').notNullable();
        table.foreign('library_id')
            .references('id')
            .inTable('libraries')
            .onDelete('CASCADE');
        table.string('title').notNullable();
        table.text('difficulty');
        table.string('composer').notNullable();
        table.string('arranger');
        table.string('instrumentation');
        table.json('metadata');
        table.json('publisher');
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.timestamp('updated_at').defaultTo(knex.fn.now());
    })
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
    return knex.schema.dropTable('pieces');
};
