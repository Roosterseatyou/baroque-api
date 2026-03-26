/**
 * Backfill allow_sharing to true for existing organizations where the column is null.
 * @param { import("knex").Knex } knex
 */
export async function up(knex) {
    // Set explicit true for any rows that have not been initialized (NULL)
    return knex('organizations')
        .whereNull('allow_sharing')
        .update({ allow_sharing: true, updated_at: knex.fn.now() });
}

/**
 * Revert the backfill by setting allow_sharing back to NULL for rows that are currently true.
 * Note: this is a best-effort revert and will clear any explicit true values; use with caution.
 * @param { import("knex").Knex } knex
 */
export async function down(knex) {
    return knex('organizations')
        .where('allow_sharing', true)
        .update({ allow_sharing: null, updated_at: knex.fn.now() });
}

