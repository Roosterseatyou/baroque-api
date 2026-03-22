/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
    return knex.schema.table('refresh_tokens', table => {
        table.string('ip').nullable();
        table.string('user_agent').nullable();
    });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
    return knex.schema.table('refresh_tokens', table => {
        table.dropColumn('user_agent');
        table.dropColumn('ip');
    });
};
