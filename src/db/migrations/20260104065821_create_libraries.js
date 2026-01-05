/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
    return knex.schema.createTable('libraries', table => {
        table.uuid('id').primary();
        table.string('org_id').notNullable();
        table.foreign('org_id')
            .references('id')
            .inTable('organizations')
            .onDelete('CASCADE');
        table.string('name').notNullable();
        table.timestamp('created_at').defaultTo(knex.fn.now());
        table.timestamp('updated_at').defaultTo(knex.fn.now());
    })
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
    return knex.schema.dropTable('libraries');
};
