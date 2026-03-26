/**
 * Add allow_sharing boolean to organizations. Default true so orgs opt-in by default.
 * @param { import("knex").Knex } knex
 */
export async function up(knex) {
    return knex.schema.table('organizations', table => {
        table.boolean('allow_sharing').defaultTo(true).nullable();
    });
}

/**
 * @param { import("knex").Knex } knex
 */
export async function down(knex) {
    return knex.schema.table('organizations', table => {
        table.dropColumn('allow_sharing');
    });
}

