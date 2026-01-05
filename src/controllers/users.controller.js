import * as usersService from '../services/users.service.js';

export async function getUserProfile(req, res) {
    try {
        const user = await usersService.getUserById(req.user.id);
        res.status(200).json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function me(req, res) {
    try {
        const user = await usersService.getCurrentUser(req.user.id);
        res.status(200).json(user);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function updateUserProfile(req, res) {
    try {
        const { name, email } = req.body;
        const updatedUser = await usersService.updateUserProfile(req.user.id, { name, email });
        res.status(200).json(updatedUser);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}

export async function deleteUser(req, res) {
    try {
        await usersService.deleteUser(req.user.id);
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function getUserOrganizations(req, res) {
    try {
        const organizations = await usersService.getUserOrganizations(req.user.id);
        res.status(200).json(organizations);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function getUserLibraries(req, res) {
    try {
        const libraries = await usersService.getUserLibraries(req.user.id);
        res.status(200).json(libraries);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}