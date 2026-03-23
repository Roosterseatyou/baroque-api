import db from '../config/knex.js';
import {generateUUID} from '../utils/uuid.js';
import {comparePassword, hashPassword} from '../utils/hash.js';
import {generateAccessToken} from '../utils/jwt.js';
import crypto from 'crypto';

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

function generateRandomString(bytes = 24) {
    return crypto.randomBytes(bytes).toString('hex');
}

function splitSelectorVerifier(cookieValue) {
    if (!cookieValue) return null;
    const parts = cookieValue.split('.');
    if (parts.length !== 2) return null;
    return { selector: parts[0], verifier: parts[1] };
}

export async function createRefreshTokenForUser(userId, ttlDays = 30, metadata = {}) {
    const selector = generateRandomString(9); // 18 hex chars
    const verifierRaw = generateRandomString(48); // 96 hex chars
    const verifierHash = await hashPassword(verifierRaw);

    const id = generateUUID();
    const expiresAt = new Date(Date.now() + (ttlDays * 24 * 60 * 60 * 1000));
    const row = {
        id,
        user_id: userId,
        selector,
        token: verifierHash,
        expires_at: expiresAt,
        ip: metadata.ip || null,
        user_agent: metadata.userAgent || null
    };
    await db('refresh_tokens').insert(row);

    const cookieValue = `${selector}.${verifierRaw}`;
    return { token: cookieValue, expires_at: expiresAt };
}

export async function revokeRefreshToken(cookieValue) {
    const parsed = splitSelectorVerifier(cookieValue);
    if (!parsed) return;
    await db('refresh_tokens').where({ selector: parsed.selector }).update({ revoked: true, revoked_at: new Date(), revoked_reason: 'user_logout' });
}

export async function revokeAllRefreshTokensForUser(userId, reason = 'compromise_detected') {
    await db('refresh_tokens').where({ user_id: userId }).update({ revoked: true, revoked_at: new Date(), revoked_reason: reason });
}

export async function loginUser({ email, password }, metadata = {}) {
    const user = await db('users').where({ email }).first();
    if (!user) {
        throw new Error('Invalid email or password');
    }

    const isPasswordValid = await comparePassword(password, user.password);
    if (!isPasswordValid) {
        throw new Error('Invalid email or password');
    }

    const payload = { id: user.id, email: user.email };
    const accessToken = generateAccessToken(payload);

    const refreshToken = await createRefreshTokenForUser(user.id, 30, metadata);

    const safeUser = { id: user.id, email: user.email, name: user.name, avatar_url: user.avatar_url };

    return { token: accessToken, refreshToken: refreshToken.token, refresh_expires_at: refreshToken.expires_at, user: safeUser };
}

export async function exchangeRefreshToken(cookieValue, rotate = true, metadata = {}) {
    const parsed = splitSelectorVerifier(cookieValue);
    if (!parsed) {
        if (process.env.NODE_ENV !== 'production') console.warn('exchangeRefreshToken: malformed refresh cookie');
        return null;
    }
    const row = await db('refresh_tokens').where({ selector: parsed.selector }).first();
    if (!row) {
        if (process.env.NODE_ENV !== 'production') console.warn('exchangeRefreshToken: no db row for selector', parsed.selector);
        return null;
    }
    if (row.revoked) {
        // If token already revoked, this is reuse attempt — revoke all tokens for user
        if (process.env.NODE_ENV !== 'production') console.warn('exchangeRefreshToken: token revoked for selector', parsed.selector);
        await revokeAllRefreshTokensForUser(row.user_id, 'reuse_after_revocation');
        return null;
    }
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
        if (process.env.NODE_ENV !== 'production') console.warn('exchangeRefreshToken: token expired for selector', parsed.selector);
        await db('refresh_tokens').where({ selector: parsed.selector }).del();
        return null;
    }

    const ok = await comparePassword(parsed.verifier, row.token);
    if (!ok) {
        // verifier mismatch but selector exists: possible theft — revoke all tokens for user
        if (process.env.NODE_ENV !== 'production') console.warn('exchangeRefreshToken: verifier mismatch for selector', parsed.selector);
        await revokeAllRefreshTokensForUser(row.user_id, 'verifier_mismatch');
        await db('refresh_tokens').where({ selector: parsed.selector }).del();
        return null;
    }

    const user = await db('users').where({ id: row.user_id }).first();
    if (!user) return null;

    const accessToken = generateAccessToken({ id: user.id, email: user.email });

    if (rotate) {
        const newRefresh = await createRefreshTokenForUser(user.id, 30, metadata);
        // mark old token as revoked and delete it (we set revoked flag and then delete the row to avoid reuse)
        await db('refresh_tokens').where({ selector: parsed.selector }).update({ revoked: true, revoked_at: new Date(), revoked_reason: 'rotated' });
        await db('refresh_tokens').where({ selector: parsed.selector }).del();
        return { accessToken, user, refreshToken: newRefresh.token, refresh_expires_at: newRefresh.expires_at };
    }

    return { accessToken, user };
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

export async function listSessionsForUser(userId) {
    // Return non-deleted tokens; keep revoked status for display
    const rows = await db('refresh_tokens')
        .where({ user_id: userId })
        .select('id', 'selector', 'created_at', 'expires_at', 'revoked', 'revoked_at', 'revoked_reason', 'ip', 'user_agent');
    return rows;
}

export async function revokeSessionBySelector(userId, selector) {
    // Only allow revoking tokens that belong to the user
    const row = await db('refresh_tokens').where({ selector }).first();
    if (!row) return false;
    if (row.user_id !== userId) return false;
    await db('refresh_tokens').where({ selector }).update({ revoked: true, revoked_at: new Date(), revoked_reason: 'user_revoked' });
    await db('refresh_tokens').where({ selector }).del();
    return true;
}
