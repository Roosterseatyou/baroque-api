import db from '../config/knex.js';
import {generateUUID} from "../utils/uuid.js";

export async function createLibrary({organizationId, creatorID, name}) {
    const libraryId = generateUUID();

    await db('libraries').insert({
        id: libraryId,
        organization_id: organizationId,
        name
    });

    await db('library_memberships').insert({
        id: generateUUID(),
        library_id: libraryId,
        user_id: creatorID,
        role: 'owner'
    })

    return { id: libraryId, organization_id: organizationId, name };
}

export async function getLibraryById(libraryId) {
    const library = await db('libraries').where({ id: libraryId }).first();
    return library;
}

export async function getLibraries(organizationId) {
    const libraries = await db('libraries')
        .where({ organization_id: organizationId });
    return libraries;
}