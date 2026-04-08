import db from '../config/knex.js'
import { generateUUID } from '../utils/uuid.js'

export async function createInvitation({ organizationId, invitedByUserId, invitedUsername = null, invitedUserId = null, invitedDiscriminator = null, role = 'viewer' }) {
  const id = generateUUID();
  await db('invitations').insert({ id, organization_id: organizationId, invited_user_id: invitedUserId, invited_username: invitedUsername, invited_discriminator: invitedDiscriminator, invited_by_user_id: invitedByUserId, role, status: 'pending', created_at: db.fn.now(), updated_at: db.fn.now() });
  return { id, organization_id: organizationId, invited_user_id: invitedUserId, invited_username: invitedUsername, invited_discriminator: invitedDiscriminator, invited_by_user_id: invitedByUserId, role, status: 'pending' };
}

export async function getInvitationsForUser(userId) {
  // Invitations explicitly addressed to this user (invited_user_id) plus those matching username can be joined in controller
  const rows = await db('invitations').where({ invited_user_id: userId }).orderBy('created_at', 'desc');
  return rows;
}

export async function getPendingInvitationsForOrganization(orgId) {
  return await db('invitations').where({ organization_id: orgId, status: 'pending' }).orderBy('created_at', 'desc');
}

export async function getInvitationById(id) {
  return await db('invitations').where({ id }).first();
}

export async function updateInvitationStatus(id, status, respondedAt = null) {
  await db('invitations').where({ id }).update({ status, updated_at: db.fn.now() });
  return await getInvitationById(id);
}

