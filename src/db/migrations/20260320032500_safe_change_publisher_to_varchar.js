/**
 * Safe migration: convert publisher JSON column to VARCHAR using a temporary column.
 * Steps (up):
 *  - Add publisher_tmp VARCHAR(255)
 *  - Populate publisher_tmp from existing JSON publisher values (object.name or string)
 *  - Drop old publisher column
 *  - Rename publisher_tmp to publisher (VARCHAR)
 *
 * Down reverses this (wrap strings into JSON objects and switch column back to JSON).
 */

/** @param { import("knex").Knex } knex */
export async function up(knex) {
  await knex.transaction(async (trx) => {
    // add temporary varchar column
    await trx.raw(
      `ALTER TABLE pieces ADD COLUMN publisher_tmp VARCHAR(255) NULL`,
    );

    // populate publisher_tmp carefully from JSON object or string values
    // JSON_UNQUOTE(JSON_EXTRACT(...)) extracts the name; JSON_UNQUOTE(publisher) extracts a JSON string value
    await trx.raw(`
      UPDATE pieces
      SET publisher_tmp = CASE
        WHEN JSON_TYPE(publisher) = 'OBJECT' AND JSON_EXTRACT(publisher, '$.name') IS NOT NULL
          THEN JSON_UNQUOTE(JSON_EXTRACT(publisher, '$.name'))
        WHEN JSON_TYPE(publisher) = 'STRING'
          THEN JSON_UNQUOTE(publisher)
        ELSE NULL
      END
    `);

    // For any remaining NULL publisher_tmp, leave as NULL. Now drop the JSON column and rename temp to publisher varchar.
    await trx.raw(`ALTER TABLE pieces DROP COLUMN publisher`);
    await trx.raw(
      `ALTER TABLE pieces CHANGE COLUMN publisher_tmp publisher VARCHAR(255) NULL`,
    );
  });
}

/** @param { import("knex").Knex } knex */
export async function down(knex) {
  await knex.transaction(async (trx) => {
    // add temporary JSON column
    await trx.raw(`ALTER TABLE pieces ADD COLUMN publisher_tmp JSON NULL`);

    // wrap existing string publisher values into simple JSON objects { name: <string> }
    await trx.raw(`
      UPDATE pieces
      SET publisher_tmp = JSON_OBJECT('name', publisher)
      WHERE publisher IS NOT NULL AND publisher <> ''
    `);

    // drop varchar column and rename tmp back to publisher JSON
    await trx.raw(`ALTER TABLE pieces DROP COLUMN publisher`);
    await trx.raw(
      `ALTER TABLE pieces CHANGE COLUMN publisher_tmp publisher JSON NULL`,
    );
  });
}
