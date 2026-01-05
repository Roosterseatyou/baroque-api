/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
    return knex.schema.createTable('oauth_info', table => {
        table.uuid('id').primary();
        table.uuid('user_id').notNullable();
        table.foreign('user_id')
            .references('id')
            .inTable('users')
            .onDelete('CASCADE');
        table.string('email');
        table.string('provider').notNullable();
        table.string('provider_user_id').notNullable();
        table.string('avatar_url').notNullable();
        table.string('access_token').notNullable();
        table.string('refresh_token');
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.timestamp('updated_at').defaultTo(knex.fn.now());
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
    return knex.schema.dropTable('oauth_info');
};
