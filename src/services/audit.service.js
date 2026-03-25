import db from '../config/knex.js';
import { generateUUID } from '../utils/uuid.js';

// Write an audit row. If a Knex transaction object (trx) is provided it will be used
// so the audit insert participates in the same transaction (and will roll back on failure).
export async function writeAudit({ entityType, entityId = null, action, details = null, performedBy = null }, trx = null) {
    const id = generateUUID();
    const row = {
        id,
        entity_type: entityType,
        entity_id: entityId,
        action,
        details: details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null,
        performed_by: performedBy || null,
        created_at: (trx || db).fn.now()
    };
    if (trx) {
        await trx('audit_logs').insert(row);
    } else {
        await db('audit_logs').insert(row);
    }
    return id;
}

