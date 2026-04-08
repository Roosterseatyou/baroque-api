import * as orgsService from '../services/orgs.service.js';

export async function createOrganization(req, res) {
    try {
        const { name } = req.body;
        const { id, name: orgName, defaultLibrary } = await orgsService.createOrganization({ userId: req.user.id, name });
        res.status(201).json({ id, name: orgName, defaultLibrary });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}

export async function getOrganization(req, res) {
    try {
        const organization = await orgsService.getOrganizationById(req.params.organizationId);
        if (!organization) {
            return res.status(404).json({ error: 'Organization not found' });
        }
        // include the current user's membership info (if any) to avoid extra round-trip from the frontend
        let membership = null;
        try {
            if (req.user && req.user.id) {
                membership = await orgsService.getMembershipForUser(req.params.organizationId, req.user.id);
            }
        } catch (e) {
            // non-fatal: if membership lookup fails, continue without it
            membership = null;
        }

        // Return the organization along with membership info
        res.status(200).json({ ...organization, membership });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function addMember(req, res) {
    try {
        const { userId, username, role } = req.body;
        // If a direct userId is provided and caller wants immediate add, honor it
        if (userId) {
                    // Direct add path: require an elevated requester role (owner/admin/manager).
                    // Default role for the new member
                    const inviteRole = role || 'viewer'

                    const requesterId = req.user && req.user.id
                    const requesterMembership = await orgsService.getMembershipForUser(req.params.organizationId, requesterId)
                    if (!requesterMembership || !['owner','admin','manager'].includes(requesterMembership.role)) {
                        return res.status(403).json({ error: 'Forbidden' })
                    }

                    // Admins cannot add an owner
                    if (requesterMembership.role === 'admin' && inviteRole === 'owner') {
                        return res.status(403).json({ error: 'Admins cannot assign owner role' })
                    }

                    const existing = await orgsService.getMembershipForUser(req.params.organizationId, userId);
                    if (existing) return res.status(409).json({ error: 'User is already a member of this organization' });
                    const membership = await orgsService.addMemberToOrganization({ organizationId: req.params.organizationId, userId, role: inviteRole });
                    return res.status(201).json(membership);
        }

        // Otherwise create an invitation record so the target user can accept/decline
        if (!username) return res.status(400).json({ error: 'username required to invite' });
        const invitationsController = await import('./invitations.controller.js');
        // delegate to invitations controller createInvite which will resolve user if possible
        return invitationsController.createInvite(req, res);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}

export async function getMembers(req, res) {
    try {
        const members = await orgsService.getOrganizationMembers(req.params.organizationId);
        res.status(200).json(members);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function removeMember(req, res) {
    try {
        const { userId } = req.body;
        const requesterId = req.user && req.user.id;
        if (!userId) return res.status(400).json({ error: 'userId required' });

        // load memberships for requester and target
        const requesterMembership = await orgsService.getMembershipForUser(req.params.organizationId, requesterId);
        const targetMembership = await orgsService.getMembershipForUser(req.params.organizationId, userId);
        if (!targetMembership) return res.status(404).json({ error: 'User is not a member' });

        // allow self-removal
        if (String(requesterId) === String(userId)) {
            await orgsService.removeMemberFromOrganization({ organizationId: req.params.organizationId, userId });
            return res.status(204).send();
        }

        // require requester to have membership with role owner or admin
        if (!requesterMembership || !['owner', 'admin'].includes(requesterMembership.role)) {
            return res.status(403).json({ error: 'Forbidden' });
        }

        // admin cannot remove an owner
        if (requesterMembership.role === 'admin' && targetMembership.role === 'owner') {
            return res.status(403).json({ error: 'Admins cannot remove owners' });
        }

        // perform removal
        await orgsService.removeMemberFromOrganization({ organizationId: req.params.organizationId, userId });
        res.status(204).send();
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}

export async function updateMemberRole(req, res) {
    try {
        const { userId } = req.params; // target user id from URL
        const { role } = req.body;
        const requesterId = req.user && req.user.id;
        if (!role) return res.status(400).json({ error: 'role required' });

        const requesterMembership = await orgsService.getMembershipForUser(req.params.organizationId, requesterId);
        const targetMembership = await orgsService.getMembershipForUser(req.params.organizationId, userId);
        if (!targetMembership) return res.status(404).json({ error: 'User is not a member' });

        // Disallow changing own role via this endpoint
        if (String(requesterId) === String(userId)) return res.status(400).json({ error: 'Cannot change your own role' });

        // Only owner or admin can change roles
        if (!requesterMembership || !['owner', 'admin'].includes(requesterMembership.role)) return res.status(403).json({ error: 'Forbidden' });

        // Admins cannot change the role of an owner
        if (requesterMembership.role === 'admin' && targetMembership.role === 'owner') {
            return res.status(403).json({ error: 'Admins cannot modify owners' });
        }

        // Admins cannot promote someone to owner
        if (requesterMembership.role === 'admin' && role === 'owner') {
            return res.status(403).json({ error: 'Admins cannot promote to owner' });
        }

        // perform update
        await orgsService.updateMemberRole({ organizationId: req.params.organizationId, userId, role });
        res.status(200).json({ success: true });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}

export async function updateOrganization(req, res) {
    try {
        const { name, allow_sharing } = req.body;
        // only allow updating allow_sharing if caller has permission (membership check is above in route)
        await orgsService.updateOrganization(req.params.organizationId, { name });
        // update settings separately so we don't mix signature with existing function
        if (typeof allow_sharing !== 'undefined') {
            // require an elevated membership
            const membership = await orgsService.getMembershipForUser(req.params.organizationId, req.user && req.user.id);
            if (!membership || !['owner','admin'].includes(membership.role)) return res.status(403).json({ error: 'Forbidden' });
            await orgsService.updateOrganizationSettings(req.params.organizationId, { allow_sharing: !!allow_sharing });
        }
        const latest = await orgsService.getOrganizationById(req.params.organizationId);
        res.status(200).json(latest);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}

export async function deleteOrganization(req, res) {
    try {
        const performer = req.user && req.user.id || null;
        await orgsService.deleteOrganization(req.params.organizationId, performer);
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function restoreOrganization(req, res) {
    try {
        const requesterId = req.user && req.user.id;
        const orgId = req.params.organizationId;
        // Allow org member with sufficient role or admin secret
        const adminSecret = req.get('X-ADMIN-SECRET') || process.env.ADMIN_SECRET;
        if (adminSecret && process.env.ADMIN_SECRET && adminSecret === process.env.ADMIN_SECRET) {
            await orgsService.restoreOrganization(orgId);
            return res.status(200).json({ success: true });
        }
        // Otherwise require a role in the organization
            const membership = await orgsService.getMembershipForUser(orgId, requesterId);
            if (membership) {
                if (!['admin', 'owner', 'manager'].includes(membership.role)) return res.status(403).json({ error: 'Forbidden' });
                await orgsService.restoreOrganization(orgId);
                return res.status(200).json({ success: true });
            }

            // Not a current member: if requester is the original deleter, allow restore
            try {
                const orgRow = await orgsService.getOrganizationEvenIfDeleted(orgId);
                if (orgRow && orgRow.deleted_by && orgRow.deleted_by === requesterId) {
                    await orgsService.restoreOrganization(orgId);
                    return res.status(200).json({ success: true });
                }
                // Fallback: check audit_logs for an entry where performed_by = requesterId
                        const knex = (await import('../config/knex.js')).default;
                        const audit = await knex('audit_logs')
                            .where({ action: 'organization_soft_deleted', entity_id: orgId })
                            .andWhere(function () {
                                this.where({ performed_by: requesterId }).orWhere('details', 'like', `%${requesterId}%`)
                            })
                            .first();
                if (audit) {
                    await orgsService.restoreOrganization(orgId);
                    return res.status(200).json({ success: true });
                }
            } catch (e) {
                // continue to forbidden below
            }

            return res.status(403).json({ error: 'Forbidden' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function hardDeleteOrganization(req, res) {
    try {
        const requesterId = req.user && req.user.id;
        const orgId = req.params.organizationId;
        const adminSecret = req.get('X-ADMIN-SECRET') || process.env.ADMIN_SECRET;
        // admin secret may authorize hard delete
        if (adminSecret && process.env.ADMIN_SECRET && adminSecret === process.env.ADMIN_SECRET) {
            await orgsService.hardDeleteOrganization(orgId, null);
            return res.status(200).json({ success: true });
        }

        // require membership with sufficient role if present
        const membership = await orgsService.getMembershipForUser(orgId, requesterId);
        if (membership) {
            if (!['admin', 'owner', 'manager'].includes(membership.role)) return res.status(403).json({ error: 'Forbidden' });
            await orgsService.hardDeleteOrganization(orgId, requesterId);
            return res.status(200).json({ success: true });
        }

        // Not a current member: allow original deleter to hard-delete (check deleted_by or audit)
        try {
            const orgRow = await orgsService.getOrganizationEvenIfDeleted(orgId);
            if (orgRow && orgRow.deleted_by && orgRow.deleted_by === requesterId) {
                await orgsService.hardDeleteOrganization(orgId, requesterId);
                return res.status(200).json({ success: true });
            }
            const knex = (await import('../config/knex.js')).default;
            const audit = await knex('audit_logs')
                .where({ action: 'organization_soft_deleted', entity_id: orgId })
                .andWhere(function () {
                    this.where({ performed_by: requesterId }).orWhere('details', 'like', `%${requesterId}%`)
                })
                .first();
            if (audit) {
                await orgsService.hardDeleteOrganization(orgId, requesterId);
                return res.status(200).json({ success: true });
            }
        } catch (e) {
            // continue to forbidden
        }

        return res.status(403).json({ error: 'Forbidden' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

