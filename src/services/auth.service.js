import db from '../config/knex.js';
import {generateUUID} from '../utils/uuid.js';
import {comparePassword, hashPassword} from '../utils/hash.js';
import {generateToken} from '../utils/jwt.js';

export async function registerUser({ email, name, password }) {
    const existingUser = await db('users').where({ email }).first();
    if (existingUser) {
        throw new Error('User already exists');
    }

    const id = generateUUID();
    const hashedPassword = await hashPassword(password);

    await db('users').insert({
        id,
        email,
        name,
        password: hashedPassword,
    });

    return { id, email, name };
}

export async function loginUser({ email, password }) {
    const user = await db('users').where({ email }).first();
    if (!user) {
        throw new Error('Invalid email or password');
    }

    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) {
        throw new Error('Invalid email or password');
    }

    // Put 'id' on the token payload so downstream code can read req.user.id
    const payload = { id: user.id, email: user.email };
    const token = generateToken(payload);

    return { token };
}

export async function createOrFindUserByGoogle(profile) {
    const {
        googleId,
        email,
        name,
        avatarUrl,
        accessToken,
        refreshToken
    } = profile;
    const existingOAuth = await db('oauth_info')
        .where({ provider: 'google', provider_user_id: googleId })
        .first();

    if (existingOAuth) {
        return db('users').where({id: existingOAuth.user_id}).first();
    }
    let user = await db('users').where({ email }).first();
    if (!user) {
        const userId = generateUUID();
        await db('users').insert({
            id: userId,
            email,
            name,
            avatar_url: avatarUrl,
        });
        user = await db('users').where({ id: userId }).first();
    }
    await db('oauth_info').insert({
        id: generateUUID(),
        user_id: user.id,
        email,
        provider: 'google',
        provider_user_id: googleId,
        avatar_url: avatarUrl,
        access_token: accessToken,
        refresh_token: refreshToken
    });
    return user;
}