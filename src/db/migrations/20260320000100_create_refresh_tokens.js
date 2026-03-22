/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
    return knex.schema.createTable('refresh_tokens', table => {
        table.uuid('id').primary();
        table.uuid('user_id').notNullable();
        table.foreign('user_id').references('id').inTable('users').onDelete('CASCADE');
        table.string('token').notNullable().unique();
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.timestamp('expires_at');
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
    return knex.schema.dropTable('refresh_tokens');
};
