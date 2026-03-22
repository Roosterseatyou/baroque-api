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

// helper: get a single library membership for a user
export async function getMembershipForUser(libraryId, userId) {
    const row = await db('library_memberships')
        .where({ library_id: libraryId, user_id: userId })
        .first();
    if (!row) return null;
    return { id: row.id, library_id: row.library_id, user_id: row.user_id, role: row.role };
}
