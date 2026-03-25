import * as orgsService from '../services/orgs.service.js';
import * as usersService from '../services/users.service.js';

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
        const { userId, email, role } = req.body;
        let targetUserId = userId;
        if (!targetUserId && email) {
            const user = await usersService.getUserByEmail(email.trim().toLowerCase());
            if (!user) return res.status(404).json({ error: 'User not found for provided email' });
            targetUserId = user.id;
        }
        if (!targetUserId) return res.status(400).json({ error: 'userId or email required' });

        // default role to 'viewer' if not provided
        const inviteRole = role || 'viewer'

        // avoid duplicate membership
        const existing = await orgsService.getMembershipForUser(req.params.organizationId, targetUserId);
        if (existing) return res.status(409).json({ error: 'User is already a member of this organization' });

        const membership = await orgsService.addMemberToOrganization({
            organizationId: req.params.organizationId,
            userId: targetUserId,
            role: inviteRole
        });
        res.status(201).json(membership);
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
        await orgsService.removeMemberFromOrganization({
            organizationId: req.params.organizationId,
            userId
        });
        res.status(204).send();
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}

export async function updateOrganization(req, res) {
    try {
        const { name } = req.body;
        const updatedOrganization = await orgsService.updateOrganization(req.params.organizationId, { name });
        res.status(200).json(updatedOrganization);
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

