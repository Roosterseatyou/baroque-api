import db from '../config/knex.js';
import { generateUUID } from '../utils/uuid.js';

export async function createOrganization({userId, name}) {
    const organizationId = generateUUID();

    await db('organizations').insert({
        id: organizationId,
        name
    })

    await db('organization_memberships').insert({
        id: generateUUID(),
        organization_id: organizationId,
        user_id: userId,
        role: 'owner'
    });

    // create a default library for the organization
    const libraryId = generateUUID();
    const defaultLibraryName = 'Default Library';
    await db('libraries').insert({
        id: libraryId,
        organization_id: organizationId,
        name: defaultLibraryName
    });

    // create a library membership for the creator (owner)
    await db('library_memberships').insert({
        id: generateUUID(),
        library_id: libraryId,
        user_id: userId,
        role: 'owner'
    });

    return { id: organizationId, name, defaultLibrary: { id: libraryId, name: defaultLibraryName } };
}

export async function getOrganizationById(organizationId) {
    const organization = await db('organizations').where({ id: organizationId }).whereNull('deleted_at').first();
    return organization;
}

export async function getOrganizationEvenIfDeleted(organizationId) {
    const organization = await db('organizations').where({ id: organizationId }).first();
    return organization;
}

export async function addMemberToOrganization({ organizationId, userId, role }) {
    const membershipId = generateUUID();

    await db('organization_memberships').insert({
        id: membershipId,
        organization_id: organizationId,
        user_id: userId,
        role
    });

    return { id: membershipId, organization_id: organizationId, user_id: userId, role };
}

export async function getOrganizationMembers(organizationId) {
    const members = await db('organization_memberships')
        .join('users', 'organization_memberships.user_id', 'users.id')
        .where('organization_memberships.organization_id', organizationId)
        .select('users.id', 'users.name', 'users.username', 'users.discriminator', 'organization_memberships.role as membership_role');
    return members;
}

// helper: get a single membership for a given user in an organization
export async function getMembershipForUser(organizationId, userId) {
    const row = await db('organization_memberships')
        .where({ organization_id: organizationId, user_id: userId })
        .first();
    if (!row) return null;
    return { id: row.id, organization_id: row.organization_id, user_id: row.user_id, role: row.role };
}

export async function removeMemberFromOrganization({ organizationId, userId }) {
    await db('organization_memberships')
        .where({ organization_id: organizationId, user_id: userId })
        .del();
}

export async function updateMemberRole({ organizationId, userId, role }) {
    // validate role
    const allowed = ['viewer','editor','admin','owner','manager'];
    if (!allowed.includes(role)) throw new Error('Invalid role');
    await db('organization_memberships').where({ organization_id: organizationId, user_id: userId }).update({ role, updated_at: db.fn.now() });
    const row = await db('organization_memberships').where({ organization_id: organizationId, user_id: userId }).first();
    if (!row) throw new Error('Membership not found');
    return { id: row.id, organization_id: row.organization_id, user_id: row.user_id, role: row.role };
}

export async function updateOrganization(organizationId, { name }) {
    await db('organizations')
        .where({ id: organizationId })
        .update({ name, updated_at: db.fn.now() });

    const updatedOrganization = await getOrganizationById(organizationId);
    return updatedOrganization;
}

export async function updateOrganizationSettings(organizationId, { allow_sharing }) {
    const update = {};
    if (typeof allow_sharing !== 'undefined') update.allow_sharing = allow_sharing;
    if (Object.keys(update).length === 0) return await getOrganizationById(organizationId);
    update.updated_at = db.fn.now();
    await db('organizations').where({ id: organizationId }).update(update);
    return await getOrganizationById(organizationId);
}

export async function deleteOrganization(organizationId, performedBy = null) {
    // Soft-delete organization by setting deleted_at so it can be restored later
    // fetch existing org name for audit details
    const org = await db('organizations').where({ id: organizationId }).first();
    const orgName = org ? org.name : null;
    // schedule deletion: soft-delete now and set deletion_scheduled_at to 30 days in future (configurable via env)
    const days = Number(process.env.ORGANIZATION_DELETION_GRACE_DAYS || 30);
    const scheduledAt = db.raw("DATE_ADD(NOW(), INTERVAL ? DAY)", [days]);

    await db('organizations')
        .where({ id: organizationId })
        .update({ deleted_at: db.fn.now(), updated_at: db.fn.now(), deleted_by: performedBy || null, deletion_scheduled_at: scheduledAt });
    // record audit entry for soft-delete and scheduling, include performing user and org name if available
    await import('./audit.service.js').then(a => a.writeAudit({ entityType: 'organization', entityId: organizationId, action: 'organization_soft_deleted', details: orgName ? { name: orgName, scheduled_days: days } : { scheduled_days: days }, performedBy: performedBy || null }));
}

export async function scheduleOrganizationHardDelete(organizationId, when, performedBy = null) {
    // helper to directly set deletion_scheduled_at to specific timestamp (when should be a JS Date or ISO string)
    await db('organizations').where({ id: organizationId }).update({ deletion_scheduled_at: when });
    try { await import('./audit.service.js').then(a => a.writeAudit({ entityType: 'organization', entityId: organizationId, action: 'organization_deletion_scheduled', details: { when }, performedBy: performedBy || null })); } catch (e) {}
}

export async function restoreOrganization(organizationId) {
    await db('organizations').where({ id: organizationId }).update({ deleted_at: null, updated_at: db.fn.now() });
    await import('./audit.service.js').then(a => a.writeAudit({ entityType: 'organization', entityId: organizationId, action: 'organization_restored', details: null, performedBy: null }));
}

// Hard-delete an organization and cascade-delete all library-related data explicitly.
// If a Knex transaction (trx) is provided it will be used so the deletions participate in the same transaction.
export async function hardDeleteOrganization(organizationId, performedBy = null, trx = null) {
    const q = trx || db;
    // Delete child rows in order to avoid FK issues (safe even if FK cascade exists)
    try {
        // Find library ids for this organization
        const libIdsQuery = q('libraries').where({ organization_id: organizationId }).select('id');

        // Delete piece_tags where piece belongs to these libraries
        await q('piece_tags').whereIn('piece_id', q('pieces').whereIn('library_id', libIdsQuery).select('id')).del();
        // Delete piece_comments for pieces in these libraries
        await q('piece_comments').whereIn('piece_id', q('pieces').whereIn('library_id', libIdsQuery).select('id')).del();
        // Delete pieces
        await q('pieces').whereIn('library_id', libIdsQuery).del();
        // Delete tags and piece_tags referencing them (tags are per-library)
        await q('piece_tags').whereIn('tag_id', q('tags').whereIn('library_id', libIdsQuery).select('id')).del();
        await q('tags').whereIn('library_id', libIdsQuery).del();
        // Delete library memberships
        await q('library_memberships').whereIn('library_id', libIdsQuery).del();
        // Delete libraries
        await q('libraries').where({ organization_id: organizationId }).del();
        // Delete organization memberships
        await q('organization_memberships').where({ organization_id: organizationId }).del();
        // Finally delete the organization row
        await q('organizations').where({ id: organizationId }).del();

        // Write audit entry for hard delete (include performer if provided)
        await import('./audit.service.js').then(a => a.writeAudit({ entityType: 'organization', entityId: organizationId, action: 'organization_deleted_hard', details: null, performedBy: performedBy || null }, trx));
    } catch (err) {
        // rethrow so callers can handle
        throw err;
    }
}

