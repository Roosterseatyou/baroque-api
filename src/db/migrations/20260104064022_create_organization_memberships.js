/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
    return knex.schema.createTable('organization_memberships', table => {
        table.uuid('id').primary();
        table.uuid('organization_id').notNullable();
        table.foreign('organization_id')
            .references('id')
            .inTable('organizations')
            .onDelete('CASCADE');
        table.uuid('user_id').notNullable();
        table.foreign('user_id')
            .references('id')
            .inTable('users')
            .onDelete('CASCADE');
        table.string('role');
        table.timestamp('created_at').defaultTo(knex.fn.now());
    })
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
    return knex.schema.dropTable('organizations');
};
