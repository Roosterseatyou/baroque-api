import * as invitationsService from '../services/invitations.service.js'
import * as usersService from '../services/users.service.js'
import { generateUUID } from '../utils/uuid.js'

export async function createInvite(req, res) {
  try {
    const orgId = req.params.organizationId
    const { username } = req.body
    const invitedBy = req.user && req.user.id
    if (!username) return res.status(400).json({ error: 'username required' })

    // Try to resolve the user by handle. Store username and discriminator separately when possible
    // to allow exact handle matching later. For unresolved inputs, preserve the raw username and
    // leave invited_discriminator null (legacy behavior).
    const rawInput = username.trim()
    let invitedUser = await usersService.getUserByHandle(rawInput)
    const invitedUserId = invitedUser ? invitedUser.id : null
    let invitedUsernameToStore = rawInput
    let invitedDiscriminatorToStore = null

    if (invitedUser) {
      invitedUsernameToStore = invitedUser.username
      invitedDiscriminatorToStore = invitedUser.discriminator
    } else if (rawInput.includes('#')) {
      // If caller provided a handle like alice#1234 but it didn't resolve to an existing user,
      // store the parts separately so the invite targets that specific handle if/when created.
      const parts = rawInput.split('#')
      invitedUsernameToStore = parts[0].trim()
      invitedDiscriminatorToStore = (parts[1] || '').trim() || null
    }

    const invite = await invitationsService.createInvitation({ organizationId: orgId, invitedByUserId: invitedBy, invitedUsername: invitedUsernameToStore, invitedDiscriminator: invitedDiscriminatorToStore, invitedUserId, role: req.body.role || 'viewer' })
    return res.status(201).json(invite)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

export async function listUserInvites(req, res) {
  try {
    const userId = req.user && req.user.id
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })
    // join with organizations (to get org name) and users (inviter name)
    const knex = (await import('../config/knex.js')).default
    // fetch current user's username for matching invited_username
    const currentUser = await knex('users').where({ id: userId }).first()
    const username = currentUser && currentUser.username ? currentUser.username : null

    const q = knex('invitations as i')
      .leftJoin('organizations as o', 'i.organization_id', 'o.id')
      .leftJoin('users as u', 'i.invited_by_user_id', 'u.id')
      .select('i.*', 'o.name as organization_name', 'u.name as invited_by_name')
      // Only show pending invitations in the user's notifications
      .where('i.status', 'pending')
      .orderBy('i.created_at', 'desc')

    // match either explicit invited_user_id OR invited_username matching this user's handle.
    // If stored invited_username contains a '#' it is a full handle (username#discriminator) and
    // should be matched exactly (case-insensitive on username, numeric discriminator). For legacy
    // bare-username invites, allow case-insensitive equality on username.
    q.where(function() {
      this.where('i.invited_user_id', userId)
      if (username) {
        // If current user has a discriminator, match stored pair (invited_username + invited_discriminator)
        if (currentUser && currentUser.discriminator) {
          this.orWhere(function() {
            this.whereRaw('LOWER(i.invited_username) = LOWER(?)', [username])
                .andWhere('i.invited_discriminator', currentUser.discriminator)
          })
        }
        // Also allow legacy invites that stored bare usernames (invited_discriminator is null)
        this.orWhere(function() {
          this.whereRaw('LOWER(i.invited_username) = LOWER(?)', [username]).andWhere('i.invited_discriminator', null)
        })
      }
    })

    const rows = await q
    return res.json(rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

export async function respondInvite(req, res) {
  try {
    const userId = req.user && req.user.id
    const { inviteId } = req.params
    const { action } = req.body // 'accept' or 'decline'
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })
    if (!['accept','decline'].includes(action)) return res.status(400).json({ error: 'invalid action' })
    const knex = (await import('../config/knex.js')).default

    let result = null
    await knex.transaction(async (trx) => {
      // Lock the invitation row to avoid race conditions
      const invite = await trx('invitations').where({ id: inviteId }).forUpdate().first()
      if (!invite) throw new Error('Invitation not found')

      // If already responded, return current row
      if (invite.status && invite.status !== 'pending') {
        result = invite
        return
      }

      // Authorization: only the invited user may accept/decline
      const currentUser = await trx('users').where({ id: userId }).first()
      const currentUsername = currentUser && currentUser.username ? currentUser.username : null

      if (invite.invited_user_id) {
        if (invite.invited_user_id !== userId) throw new Error('Forbidden')
      } else if (invite.invited_username) {
        // If invite stored an invited_discriminator, require exact match to that handle
        if (invite.invited_discriminator) {
          if (!currentUser.discriminator) throw new Error('Forbidden')
          if (currentUsername.toLowerCase() !== String(invite.invited_username).toLowerCase() || currentUser.discriminator !== invite.invited_discriminator) {
            throw new Error('Forbidden')
          }
        } else {
          // legacy bare-username invites: compare case-insensitively against current username
          if (!currentUsername || invite.invited_username.toLowerCase() !== currentUsername.toLowerCase()) {
            throw new Error('Forbidden')
          }
        }
      } else {
        throw new Error('Forbidden')
      }

      if (action === 'decline') {
        await trx('invitations').where({ id: inviteId }).update({ status: 'declined', updated_at: trx.fn.now() })
        result = await trx('invitations').where({ id: inviteId }).first()
        return
      }

      // Accept flow: resolve current target user id
      let targetUserId = invite.invited_user_id
      if (!targetUserId && invite.invited_username) {
        // Prefer resolving by stored discriminator when present
        if (invite.invited_discriminator) {
          const u = await trx('users').whereRaw('LOWER(username)=LOWER(?)', [invite.invited_username]).andWhere({ discriminator: invite.invited_discriminator }).first()
          if (u) targetUserId = u.id
        } else {
          // legacy bare-username: attempt a case-insensitive lookup; if multiple exist, prefer nothing
          const matches = await trx('users').whereRaw('LOWER(username)=LOWER(?)', [invite.invited_username]).select('id')
          if (matches && matches.length === 1) targetUserId = matches[0].id
        }
      }
      if (!targetUserId) targetUserId = userId

      // Avoid duplicate membership
      const existing = await trx('organization_memberships').where({ organization_id: invite.organization_id, user_id: targetUserId }).first()
      if (!existing) {
        await trx('organization_memberships').insert({ id: generateUUID(), organization_id: invite.organization_id, user_id: targetUserId, role: invite.role, created_at: trx.fn.now() })
      }

      await trx('invitations').where({ id: inviteId }).update({ status: 'accepted', updated_at: trx.fn.now() })
      result = await trx('invitations').where({ id: inviteId }).first()
    })

    // If transaction threw a specific error message, map to HTTP status
    if (!result) return res.status(500).json({ error: 'Unexpected error' })
    // Map common error messages thrown inside trx to HTTP responses
    if (result && result.error) return res.status(400).json({ error: result.error })
    return res.json(result)
  } catch (err) {
    // map known permission error
    if (err && err.message === 'Forbidden') return res.status(403).json({ error: 'Forbidden' })
    if (err && err.message === 'Invitation not found') return res.status(404).json({ error: 'Invitation not found' })
    res.status(500).json({ error: err.message })
  }
}

