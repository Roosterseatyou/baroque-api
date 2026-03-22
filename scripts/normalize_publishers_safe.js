#!/usr/bin/env node
/**
 * Safe normalization script for publisher column.
 *
 * - Detects publisher column type (JSON or varchar).
 * - For each row in `pieces`, computes a string publisher value by:
 *    - if value is null => keep null
 *    - if value is a JSON object with .name => use that
 *    - if value is a JSON string => use the string
 *    - otherwise stringify
 * - Writes back safely depending on column type:
 *    - if JSON column: write JSON_OBJECT('name', value)
 *    - if varchar: write the plain string
 *
 * Run from the `baroque-api` folder: node scripts/normalize_publishers_safe.js
 */

import knex from '../src/config/knex.js';

async function getColumnType() {
  const [{ DATA_TYPE }] = await knex.raw(`
    SELECT DATA_TYPE
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = ?
      AND TABLE_NAME = 'pieces'
      AND COLUMN_NAME = 'publisher'
  `, [knex.client.config.connection.database]).then(r => r[0]);
  return DATA_TYPE && DATA_TYPE.toLowerCase();
}

function extractPublisherString(raw) {
  if (raw === null || raw === undefined) return null;
  // knex may return JSON columns as strings or objects depending on driver; normalize
  if (typeof raw === 'string') {
    // try to parse as JSON
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.name && typeof parsed.name === 'string') return parsed.name;
        // fallback: stringify the object
        return JSON.stringify(parsed);
      }
      // parsed is primitive (string/number) -> coerce to string
      return String(parsed);
    } catch (e) {
      // not JSON, treat as literal string
      return raw;
    }
  }
  if (typeof raw === 'object') {
    if (raw.name && typeof raw.name === 'string') return raw.name;
    return JSON.stringify(raw);
  }
  // numbers or other primitives
  return String(raw);
}

async function main() {
  console.log('Starting safe normalization of pieces.publisher...');
  const colType = await getColumnType();
  console.log('Detected publisher column type:', colType);

  // fetch all pieces IDs and publisher
  const rows = await knex('pieces').select('id', 'publisher');
  console.log('Found', rows.length, 'pieces to inspect');

  let changed = 0;
  for (const row of rows) {
    const id = row.id;
    const raw = row.publisher;
    const newVal = extractPublisherString(raw);
    // if newVal is null and raw is null -> nothing to do
    if ((newVal === null || newVal === undefined) && (raw === null || raw === undefined)) continue;
    // if raw is string and equals newVal, skip
    if (typeof raw === 'string' && raw === newVal) continue;
    // otherwise update depending on column type
    try {
      if (colType === 'json') {
        if (newVal === null) {
          await knex('pieces').where({ id }).update({ publisher: null });
        } else {
          // use JSON_OBJECT to safely create JSON
          await knex.raw(`UPDATE pieces SET publisher = JSON_OBJECT('name', ?) WHERE id = ?`, [newVal, id]);
        }
      } else {
        // varchar or text
        await knex('pieces').where({ id }).update({ publisher: newVal });
      }
      changed++;
    } catch (err) {
      console.error('Failed updating piece', id, err && err.message);
      // continue
    }
  }

  console.log('Normalization complete. Rows changed:', changed);
  await knex.destroy();
}

main().catch(err => {
  console.error('Error during normalization script:', err && err.stack);
  process.exit(1);
});
