import * as orgsService from '../services/orgs.service.js';

export async function createOrganization(req, res) {
    try {
        const { name } = req.body;
        const organization = await orgsService.createOrganization({ userId: req.user.id, name });
        res.status(201).json(organization);
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
        res.status(200).json(organization);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function addMember(req, res) {
    try {
        const { userId, role } = req.body;
        const membership = await orgsService.addMemberToOrganization({
            organizationId: req.params.organizationId,
            userId,
            role
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
        await orgsService.deleteOrganization(req.params.organizationId);
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}