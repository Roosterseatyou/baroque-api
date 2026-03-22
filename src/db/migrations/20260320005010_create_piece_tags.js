/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
    return knex.schema.createTable('piece_tags', table => {
        table.uuid('id').primary();
        table.uuid('piece_id').notNullable();
        table.foreign('piece_id').references('id').inTable('pieces').onDelete('CASCADE');
        table.uuid('tag_id').notNullable();
        table.foreign('tag_id').references('id').inTable('tags').onDelete('CASCADE');
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.unique(['piece_id','tag_id']);
    });
};

export async function down(knex) {
    return knex.schema.dropTable('piece_tags');
};
