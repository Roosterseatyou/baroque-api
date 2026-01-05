/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
    return knex.schema.createTable('library_memberships', table => {
        table.uuid('id').primary();
        table.uuid('user_id').notNullable();
        table.foreign('user_id')
            .references('id')
            .inTable('users')
            .onDelete('CASCADE');
        table.uuid('library_id').notNullable();
        table.foreign('library_id')
            .references('id')
            .inTable('libraries')
            .onDelete('CASCADE');
        table.string('role').notNullable();
        table.timestamp('createdAt').defaultTo(knex.fn.now());
    })
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
    return knex.schema.dropTable('library_memberships');
};
