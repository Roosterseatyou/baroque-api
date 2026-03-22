/**
 * Disabled/no-op migration stub.
 *
 * The original migration contained SQL that caused constraint failures on some DBs
 * and was intentionally disabled in favor of a safe migration and a normalization
 * script. Keeping this no-op stub in the migrations folder prevents Knex from
 * failing when it expects a file with this timestamp to exist in the history.
 *
 * If you intentionally want to run a real migration here, replace the bodies of
 * `up` and `down` with the required SQL operations. For now these are no-ops.
 */

/** @param { import("knex").Knex } knex */
export async function up(knex) {
  // Intentionally left blank as a safe no-op. See README and the safe migration
  // `20260320032500_safe_change_publisher_to_varchar.js` for the recommended steps.
  return Promise.resolve();
}

/** @param { import("knex").Knex } knex */
export async function down(knex) {
  // No-op rollback.
  return Promise.resolve();
}
