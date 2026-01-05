import db from '../config/knex.js';

export async function getUserById(userId) {
    const user = await db('users').where({ id: userId }).first();
    return user;
}

export async function getCurrentUser(userId) {
    return await getUserById(userId);
}


export async function getUserOrganizations(userId) {
    const organizations = await db('organization_memberships')
        .join('organizations', 'organization_memberships.organization_id', 'organizations.id')
        .where('organization_memberships.user_id', userId)
        .select('organizations.*', 'organization_memberships.role as membership_role');
    return organizations;
}

export async function updateUserProfile(userId, { name, email }) {
    await db('users')
        .where({ id: userId })
        .update({ name, email });

    const updatedUser = await getUserById(userId);
    return updatedUser;
}

export async function deleteUser(userId) {
    await db('users').where({ id: userId }).del();
}

export async function getUserLibraries(userId) {
    const libraries = await db('library_memberships')
        .join('libraries', 'library_memberships.library_id', 'libraries.id')
        .where('library_memberships.user_id', userId)
        .select('libraries.*', 'library_memberships.role as membership_role');
    return libraries;
}