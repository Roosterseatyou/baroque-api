/**
 * Migration: Normalize publisher JSON in pieces table
 *
 * - Up: Convert JSON-string publishers to objects { name: <string> }
 * - Down: Convert single-key publisher objects { name: <string> } back to string values
 */

/** @param { import("knex").Knex } knex */
export async function up(knex) {
  await knex.transaction(async (trx) => {
    // Convert JSON string values into objects: "Acme" -> {"name":"Acme"}
    await trx.raw(`
      UPDATE pieces
      SET publisher = JSON_OBJECT('name', JSON_UNQUOTE(publisher))
      WHERE JSON_TYPE(publisher) = 'STRING'
    `);

    // Normalize empty or NULL-like publishers to actual SQL NULL
    await trx.raw(`
      UPDATE pieces
      SET publisher = NULL
      WHERE publisher = '' OR JSON_TYPE(publisher) = 'NULL'
    `);
  });
}

/** @param { import("knex").Knex } knex */
export async function down(knex) {
  await knex.transaction(async (trx) => {
    // Convert simple publisher objects back to strings when they only contain the name key.
    await trx.raw(`
      UPDATE pieces
      SET publisher = JSON_UNQUOTE(JSON_EXTRACT(publisher, '$.name'))
      WHERE JSON_TYPE(publisher) = 'OBJECT'
        AND JSON_EXTRACT(publisher, '$.name') IS NOT NULL
        AND JSON_LENGTH(publisher) = 1
    `);
  });
}
