import db from '../src/config/knex.js';
import { fileURLToPath } from 'url';

export async function runFixCollectionsMetadata() {
  console.log('Scanning collections.metadata for invalid JSON...');
  const rows = await db('collections').select('id', 'metadata');
  let fixed = 0;
  for (const r of rows) {
    try {
      const m = r.metadata;
      if (m === null || m === undefined) continue;
      // If the driver already returns an object, it's fine
      if (typeof m === 'object') continue;
      // If it's a string, attempt to parse
      if (typeof m === 'string') {
        try {
          const parsed = JSON.parse(m);
          // If parsed to object, keep as-is
          if (parsed && typeof parsed === 'object') continue;
          // If parsed to primitive (string like "[object Object]"), treat as invalid
        } catch (e) {
          // parse failed -> invalid
        }
        // At this point metadata is invalid: replace with empty object
        await db('collections').where({ id: r.id }).update({ metadata: JSON.stringify({}), updated_at: db.fn.now() });
        console.log(`Fixed collection ${r.id}`);
        fixed++;
      }
    } catch (e) {
      console.error('Error checking collection', r.id, e && e.message ? e.message : e);
    }
  }
  console.log(`Done. Fixed ${fixed} row(s).`);
}

// If executed directly (node scripts/fix_collections_metadata.js), run and exit accordingly
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  runFixCollectionsMetadata().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
