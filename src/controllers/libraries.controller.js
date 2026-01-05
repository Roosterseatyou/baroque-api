import * as libraryService from '../services/libraries.service.js';

export async function createLibrary(req, res) {
    try {
        const { name } = req.body;
        const library = await libraryService.createLibrary({
            organizationId: req.params.organizationId,
            creatorID: req.user.id,
            name
        });
        res.status(201).json(library);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}

export async function getLibrary(req, res) {
    try {
        const library = await libraryService.getLibraryById(req.params.libraryId);
        if (!library) {
            return res.status(404).json({ error: 'Library not found' });
        }
        res.status(200).json(library);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function getLibraries(req, res) {
    try {
        const libraries = await libraryService.getLibraries(req.params.organizationId);
        res.status(200).json(libraries);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}