import db from '../config/knex.js';
import * as orgsService from './orgs.service.js';
import * as auditService from './audit.service.js';

export async function getUserById(userId) {
    const user = await db('users').where({ id: userId }).first();
    return user;
}

export async function getCurrentUser(userId) {
    return await getUserById(userId);
}


export async function getUserOrganizations(userId) {
    const organizations = await db('organization_memberships')
        .join('organizations', 'organization_memberships.organization_id', 'organizations.id')
        .where('organization_memberships.user_id', userId)
        .whereNull('organizations.deleted_at')
        .select('organizations.*', 'organization_memberships.role as membership_role');
    return organizations;
}

export async function updateUserProfile(userId, { name, email }) {
    await db('users')
        .where({ id: userId })
        .update({ name, email });

    const updatedUser = await getUserById(userId);
    return updatedUser;
}

export async function deleteUser(userId) {
    // Deprecated simple delete. Use deleteUserData for the safe deletion flow.
    return deleteUserData(userId);
}

export async function createUserData(userId, { orgName } = {}) {
    // Create a default personal organization and return it. Uses orgsService.createOrganization
    const name = orgName || 'Personal Organization';
    const org = await orgsService.createOrganization({ userId, name });
    return org;
}

export async function deleteUserData(userId) {
    // Safe deletion: transfer ownership of organizations the user owns to another admin if possible,
    // otherwise delete the organization (cascade will remove related rows). Wrap in transaction.
    return await db.transaction(async (trx) => {
        // Find organizations where this user is owner
        const ownerRows = await trx('organization_memberships').where({ user_id: userId, role: 'owner' }).select('organization_id');

        for (const row of ownerRows) {
            const orgId = row.organization_id;
            // Try to find another admin in the organization
            const newOwner = await trx('organization_memberships')
                .where({ organization_id: orgId, role: 'admin' })
                .andWhere('user_id', '<>', userId)
                .orderBy('created_at', 'asc')
                .first();

            if (newOwner && newOwner.id) {
                // promote this admin to owner
                await trx('organization_memberships').where({ id: newOwner.id }).update({ role: 'owner' });
                // audit: record promotion (strict within trx)
                await auditService.writeAudit({ entityType: 'membership', entityId: newOwner.id, action: 'owner_promoted', details: { organization_id: orgId, promoted_user_id: newOwner.user_id }, performedBy: userId }, trx);
            } else {
                // No admin found — soft-delete the organization by setting deleted_at
                try {
                    await trx('organizations').where({ id: orgId }).update({ deleted_at: trx.fn.now(), deleted_by: userId });
                    await auditService.writeAudit({ entityType: 'organization', entityId: orgId, action: 'organization_soft_deleted', details: { reason: 'owner_deleted_no_admin' }, performedBy: userId }, trx);
                } catch (e) {
                    // fallback to hard delete if update fails for any reason — use service helper to remove all library data
                    try {
                        await orgsService.hardDeleteOrganization(orgId, trx);
                        // audit for hard delete is written by hardDeleteOrganization
                    } catch (innerErr) {
                        // if even the service helper fails, rethrow to abort the transaction
                        throw innerErr;
                    }
                }
            }
        }

        // Remove any remaining memberships (organization_memberships, library_memberships)
        await trx('organization_memberships').where({ user_id: userId }).del();
        await trx('library_memberships').where({ user_id: userId }).del();

        // Remove oauth_info, refresh tokens, oauth_states related to this user
        try { await trx('oauth_info').where({ user_id: userId }).del(); } catch (e) { /* ignore */ }
        try { await trx('refresh_tokens').where({ user_id: userId }).del(); } catch (e) { /* ignore */ }
        try { await trx('oauth_states').where({ user_id: userId }).del(); } catch (e) { /* ignore */ }

        // Finally soft-delete the user record
        // soft-delete user (strict within trx)
        await trx('users').where({ id: userId }).update({ deleted_at: trx.fn.now() });
        await auditService.writeAudit({ entityType: 'user', entityId: userId, action: 'user_soft_deleted', details: null, performedBy: userId }, trx);
    });
}

export async function restoreUser(userId) {
    // Restore user and attempt to revert ownership promotions and restore orgs that were soft-deleted when the user was removed.
    return await db.transaction(async (trx) => {
        await trx('users').where({ id: userId }).update({ deleted_at: null, updated_at: trx.fn.now() });
        await auditService.writeAudit({ entityType: 'user', entityId: userId, action: 'user_restored', details: null, performedBy: null }, trx);

        // 1) Revert owner promotions that were recorded as performed_by = userId
        const promos = await trx('audit_logs').where({ action: 'owner_promoted', performed_by: userId }).select('id','details','created_at');
        for (const p of promos) {
            let details = null;
            try { details = typeof p.details === 'string' ? JSON.parse(p.details) : p.details; } catch (e) { details = null; }
            if (!details || !details.organization_id || !details.promoted_user_id) continue;
            const orgId = details.organization_id;
            const promotedUserId = details.promoted_user_id;

            // Demote the promoted user back to 'admin' if they still have a membership
            try {
                const promotedMembership = await trx('organization_memberships').where({ organization_id: orgId, user_id: promotedUserId }).first();
                if (promotedMembership) {
                    await trx('organization_memberships').where({ id: promotedMembership.id }).update({ role: 'admin' });
                }

                // Ensure the restored user has an owner membership
                let restoreMembership = await trx('organization_memberships').where({ organization_id: orgId, user_id: userId }).first();
                if (restoreMembership) {
                    await trx('organization_memberships').where({ id: restoreMembership.id }).update({ role: 'owner' });
                } else {
                    await trx('organization_memberships').insert({ id: (await import('../utils/uuid.js')).generateUUID(), organization_id: orgId, user_id: userId, role: 'owner' });
                }

                // Audit the revert
                try {
                    await auditService.writeAudit({ entityType: 'membership', entityId: promotedMembership ? promotedMembership.id : null, action: 'owner_reverted', details: { organization_id: orgId, restored_owner_id: userId, demoted_user_id: promotedUserId, source_audit_id: p.id }, performedBy: userId }, trx);
                } catch (e) {}
            } catch (e) {
                // ignore individual failures and continue
            }
        }

        // 2) Restore organizations that were soft-deleted due to owner deletion (audit: organization_soft_deleted)
        const orgDeletes = await trx('audit_logs').where({ action: 'organization_soft_deleted', performed_by: userId }).select('id','entity_id','details');
        for (const od of orgDeletes) {
            let details = null;
            try { details = typeof od.details === 'string' ? JSON.parse(od.details) : od.details; } catch (e) { details = null; }
            const orgId = od.entity_id || (details && details.organization_id) || null;
            if (!orgId) continue;
            try {
                await trx('organizations').where({ id: orgId }).update({ deleted_at: null, updated_at: trx.fn.now() });
                await auditService.writeAudit({ entityType: 'organization', entityId: orgId, action: 'organization_restored_via_user_restore', details: { source_audit_id: od.id }, performedBy: userId }, trx);
            } catch (e) {
                // ignore and continue
            }
        }

        return true;
    });
}

export async function getUserLibraries(userId) {
    const libraries = await db('library_memberships')
        .join('libraries', 'library_memberships.library_id', 'libraries.id')
        .where('library_memberships.user_id', userId)
        .select('libraries.*', 'library_memberships.role as membership_role');
    return libraries;
}

// find a user by email (used by invitation flow)
export async function getUserByEmail(email) {
    if (!email) return null;
    const user = await db('users').where({ email }).first();
    return user || null;
}

// Return organizations that were soft-deleted and attributed to actions performed by the given user.
// This uses audit_logs entries with action 'organization_soft_deleted' where performed_by = userId
// and returns the corresponding organizations (only those with deleted_at set).
export async function getDeletedOrganizationsForUser(userId) {
    // find audit log entries where this user performed an organization deletion (soft or hard)
    // or entries whose details mention the user id (some older flows may have stored user ids only in details)
    const rows = await db('audit_logs')
        .whereIn('action', ['organization_soft_deleted', 'organization_deleted_hard'])
        .andWhere(function() {
            this.where({ performed_by: userId }).orWhere('details', 'like', `%${userId}%`)
        })
        .select('entity_id', 'action', 'details', 'created_at');
    const orgIds = [...new Set(rows.map(r => r.entity_id).filter(Boolean))];
    if (orgIds.length === 0) return [];

    // fetch only soft-deleted organization rows (exclude active/restored orgs and audit-only entries)
    const softDeletedOrgs = await db('organizations').whereIn('id', orgIds).whereNotNull('deleted_at').select('*');

    // Return only actual soft-deleted (restorable) orgs
    return softDeletedOrgs.map(o => ({ id: o.id, name: o.name, deleted_at: o.deleted_at, restorable: true }));
}

