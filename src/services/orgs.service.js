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
        role: 'admin'
    });

    return { id: organizationId, name };
}

export async function getOrganizationById(organizationId) {
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
        .select('users.id', 'users.name', 'users.email', 'organization_memberships.role');
    return members;
}

export async function removeMemberFromOrganization({ organizationId, userId }) {
    await db('organization_memberships')
        .where({ organization_id: organizationId, user_id: userId })
        .del();
}

export async function updateOrganization(organizationId, { name }) {
    await db('organizations')
        .where({ id: organizationId })
        .update({ name, updated_at: db.fn.now() });

    const updatedOrganization = await getOrganizationById(organizationId);
    return updatedOrganization;
}

export async function deleteOrganization(organizationId) {
    await db('organizations')
        .where({ id: organizationId })
        .del();
}