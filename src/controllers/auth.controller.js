import * as authService from '../services/auth.service.js';
import * as googleAuthService from '../services/googleAuth.service.js';
import crypto from 'crypto';
import debug from '../utils/debug.js'
import knex from '../config/knex.js'

const REFRESH_COOKIE_NAME = 'refresh_token';
const IS_PROD = process.env.NODE_ENV === 'production'
// Use SameSite='none' in production so the refresh cookie can be set/seen during the
// cross-site OAuth redirect from Google. Browsers require Secure when SameSite=None.
const REFRESH_COOKIE_OPTIONS = {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: IS_PROD ? 'none' : 'lax',
    // use root path so the browser includes the cookie for /auth/refresh
    path: '/',
    // maxAge not set here; the token has its own expiry in DB
};

const OAUTH_STATE_COOKIE = 'oauth_state';
// OAuth state cookie must also be settable/readable across the Google redirect.
const OAUTH_STATE_OPTIONS = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    // Use root path so the oauth state cookie is sent on the Google redirect
    // (callbacks are under /auth/google/callback for the auth flow).
    path: '/',
    maxAge: 10 * 60 * 1000 // 10 minutes
};

// Helper: build effective refresh cookie options for this request (local vs prod)
function buildRefreshCookieOptions(frontendOrigin) {
    const isLocal = frontendOrigin && (frontendOrigin.includes('localhost') || frontendOrigin.includes('127.0.0.1')) || process.env.NODE_ENV !== 'production';
    const opts = Object.assign({}, REFRESH_COOKIE_OPTIONS);
    if (isLocal) {
        // local development - allow non-secure and SameSite=lax so browsers will accept the cookie
        opts.sameSite = 'lax';
        opts.secure = false;
    } else {
        // production - require cross-site cookie support
        opts.sameSite = 'none';
        opts.secure = true;
    }
    return opts;
}

export async function register(req, res) {
    try {
        const { username, name, password } = req.body;
        const user = await authService.registerUser({ username, name, password });
        // return minimal user (no email)
        res.status(201).json({ id: user.id, username: user.username, name: user.name });
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}

export async function login(req, res) {
    try {
        const { usernameWithDisc, password } = req.body;
        const metadata = { ip: req.ip, userAgent: req.get('user-agent') };
        const { token, refreshToken, refresh_expires_at, user } = await authService.loginUser({ usernameWithDisc, password }, metadata);
        // set refresh token as httpOnly cookie
        const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
        const cookieOpts = buildRefreshCookieOptions(FRONTEND_ORIGIN);
        if (process.env.DEBUG_OAUTH === 'true') {
            debug.debugLog('auth.login: setting refresh cookie', { name: REFRESH_COOKIE_NAME, valueSnippet: (refreshToken || '').slice(0,8) + '...', options: cookieOpts });
        }
        res.cookie(REFRESH_COOKIE_NAME, refreshToken, cookieOpts);
        // Include a 'restored' flag if the login process restored a soft-deleted user
        const respUser = { id: user.id, username: user.username, discriminator: user.discriminator, name: user.name, avatar_url: user.avatar_url };
        const resp = { token, refresh_expires_at, user: respUser };
        if (typeof user?.restored !== 'undefined') resp.restored = user.restored === true;
        res.status(200).json(resp);
    } catch (error) {
        res.status(401).json({ error: error.message });
    }
}

export async function refresh(req, res) {
    try {
        const refreshToken = req.cookies && req.cookies[REFRESH_COOKIE_NAME];
        if (!refreshToken) return res.status(400).json({ error: 'refresh token cookie missing' });
        const metadata = { ip: req.ip, userAgent: req.get('user-agent') };
        const result = await authService.exchangeRefreshToken(refreshToken, true /* rotate */, metadata);
        if (!result) return res.status(401).json({ error: 'Invalid or expired refresh token' });
        // set new refresh token cookie
        const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
        const cookieOpts = buildRefreshCookieOptions(FRONTEND_ORIGIN);
        if (process.env.DEBUG_OAUTH === 'true') {
            debug.debugLog('auth.refresh: setting refresh cookie (rotated)', { name: REFRESH_COOKIE_NAME, valueSnippet: (result.refreshToken || '').slice(0,8) + '...', options: cookieOpts });
        }
        res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, cookieOpts);
        // Include a 'restored' flag when refresh restored a soft-deleted user
        const respUser = { id: result.user.id, username: result.user.username, discriminator: result.user.discriminator, name: result.user.name, avatar_url: result.user.avatar_url };
        const resp = { token: result.accessToken, user: respUser };
        if (result.restored === true || result.user?.restored === true) resp.restored = true;
        res.status(200).json(resp);
    } catch (error) {
        console.error('auth.refresh ERROR', error && error.message ? error.message : error)
        res.status(500).json({ error: error.message });
    }
}

export async function logout(req, res) {
    try {
        const refreshToken = req.cookies && req.cookies[REFRESH_COOKIE_NAME];
        if (refreshToken) {
            await authService.revokeRefreshToken(refreshToken);
        }
        // cookie is set at path '/'
        res.clearCookie(REFRESH_COOKIE_NAME, { path: '/' });
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function googleAuth(req, res) {
    // Generate a state and optional redirect target
    const state = crypto.randomBytes(16).toString('hex');
    const redirectTo = req.query.redirect || '/';
    // store state and desired redirect in a short-lived HttpOnly cookie for CSRF protection
    const payload = JSON.stringify({ state, redirectTo });

    // For local development (localhost) we ensure SameSite=Lax and secure=false so redirects from Google include the cookie.
    const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
    const isLocal = FRONTEND_ORIGIN.includes('localhost') || FRONTEND_ORIGIN.includes('127.0.0.1') || process.env.NODE_ENV !== 'production';
    const cookieOptions = Object.assign({}, OAUTH_STATE_OPTIONS);
    if (isLocal) {
        cookieOptions.sameSite = 'lax';
        cookieOptions.secure = false;
    }

    // Clear any existing oauth_state cookie first to avoid duplicates (browsers can store multiple cookies with same name/path variants)
    try {
        res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' });
    } catch (e) { /* ignore */ }

    res.cookie(OAUTH_STATE_COOKIE, payload, cookieOptions);
    // Allow configuring required OAuth scopes via env (comma- or space-separated). If not set,
    // include the basic openid/email/profile plus Drive/Sheets readonly used by integrations.
    const DEFAULT_SCOPES = [
        'openid',
        'email',
        'profile'
    ];
    const raw = process.env.GOOGLE_OAUTH_SCOPES || DEFAULT_SCOPES.join(' ');
    // pass includeGrantedScopes=false to force consent for requested scopes on first-login
    const url = googleAuthService.getGoogleAuth(state, raw, false);
    return res.redirect(url);
}

export async function googleCallback(req, res) {
    try {
        debug.debugLog('auth.googleCallback invoked:', { url: req.originalUrl, path: req.path, cookiesHeader: req.headers && req.headers.cookie ? req.headers.cookie : null });
        const { code, state } = req.query;
        if (!code) return res.status(400).json({ error: 'code not found' });
        // validate state from cookie (strict)
        // Try multiple approaches to find the oauth_state payload because some browsers/clients
        // can send duplicate cookies or different encodings which can cause a mismatch.
        let parsed = null;

        // 1) Prefer parsed cookie from cookie-parser
        const stateCookie = req.cookies && req.cookies[OAUTH_STATE_COOKIE];
        if (stateCookie) {
            try { parsed = JSON.parse(stateCookie); } catch (e) { parsed = null; }
        }

        // 2) If not found or didn't match, scan raw Cookie header for any oauth_state entries and
        // check each one (handles duplicates and different encodings)
        if (!parsed || parsed.state !== state) {
            const rawCookies = req.headers && req.headers.cookie;
            if (rawCookies) {
                // find all occurrences of "oauth_state=..." in the header
                const regex = /(?:^|;\s*)oauth_state=([^;]+)/g;
                let m;
                while ((m = regex.exec(rawCookies)) !== null) {
                    const rawVal = m[1] || '';
                    // tolerant normalization: strip surrounding quotes and convert '+' to '%20'
                    let norm = rawVal.replace(/^"|"$/g, '');
                    norm = norm.replace(/\+/g, '%20');
                    let decoded = null;
                    try { decoded = decodeURIComponent(norm); } catch (e) { decoded = norm; }
                    try {
                        const candidate = JSON.parse(decoded);
                        if (process.env.DEBUG_OAUTH === 'true') {
                            debug.debugLog('auth.googleCallback: scanned oauth_state candidate', { rawVal, norm, decoded, candidateState: candidate && candidate.state ? candidate.state : null });
                        }
                        if (candidate && candidate.state === state) { parsed = candidate; break; }
                    } catch (e) {
                        // If JSON.parse failed, be tolerant and try to extract a state string from the decoded value.
                        // Cases handled: decoded may be a plain state string, or a serialized object missing proper encoding.
                        const plain = decoded && decoded.toString ? decoded.toString() : '';
                        if (plain === state) { parsed = { state: plain }; break; }
                        // try to pull a "state":"..." value using a regex
                        const m2 = /"state"\s*:\s*"([^"]+)"/.exec(plain);
                        if (m2 && m2[1]) {
                            if (m2[1] === state) { parsed = { state: m2[1] }; break; }
                        }
                        // try a looser extraction: state=abc in query-like strings
                        const m3 = /state=([a-f0-9]+)/i.exec(plain);
                        if (m3 && m3[1] && m3[1] === state) { parsed = { state: m3[1] }; break; }
                        // otherwise ignore
                    }
                }
            }
        }

        if (!parsed || parsed.state !== state) {
            // As a fallback, the app also persists oauth_states server-side for some flows.
            // If cookie-based matching failed (browsers sometimes drop or re-encode cookies during
            // the Google redirect), try to find a matching record in the oauth_states table.
            try {
                const record = await knex('oauth_states').where({ state }).first();
                if (record) {
                    parsed = { state: record.state, redirectTo: record.redirect_to };
                    // best-effort cleanup
                    try { await knex('oauth_states').where({ state }).del() } catch (e) { /* ignore */ }
                }
            } catch (e) {
                if (process.env.DEBUG_OAUTH === 'true') debug.debugLog('auth.googleCallback: oauth_states DB lookup failed', { err: e && e.message ? e.message : e });
            }
        }

        if (!parsed || parsed.state !== state) {
            if (process.env.DEBUG_OAUTH === 'true') {
                debug.debugLog('auth.googleCallback: oauth state mismatch or missing', { expectedState: state, parsedState: parsed ? parsed.state : null, rawCookies: req.headers && req.headers.cookie ? req.headers.cookie : null });
            }
            return res.status(400).json({ error: 'invalid oauth state' });
        }

         // clear oauth state cookie (best-effort)
         try { res.clearCookie(OAUTH_STATE_COOKIE, { path: '/' }); } catch(e) { /* ignore */ }

         const googleUser = await googleAuthService.exchangeCodeForUser(code);
         const user = await authService.createOrFindUserByGoogle(googleUser);

         // create server refresh token and set as HttpOnly cookie
         const metadata = { ip: req.ip, userAgent: req.get('user-agent') };
         const refresh = await authService.createRefreshTokenForUser(user.id, 30, metadata);
         const FRONTEND_ORIGIN_CB = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
         const cookieOpts = buildRefreshCookieOptions(FRONTEND_ORIGIN_CB);
         if (process.env.DEBUG_OAUTH === 'true') {
             debug.debugLog('auth.googleCallback: setting refresh cookie from google callback', { name: REFRESH_COOKIE_NAME, valueSnippet: (refresh.token || '').slice(0,8) + '...', options: cookieOpts });
         }
         res.cookie(REFRESH_COOKIE_NAME, refresh.token, cookieOpts);

         // redirect back to frontend. Use redirect from state cookie if present
         const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
         const redirectPath = (parsed && parsed.redirectTo) ? parsed.redirectTo : '/';
         const redirectUrl = `${FRONTEND_ORIGIN}/oauth-callback?redirect=${encodeURIComponent(redirectPath)}`;

         // For SPA flow we redirect and let the client call /auth/refresh to obtain access token
         return res.redirect(redirectUrl);
     } catch (error) {
        console.error('googleCallback error', error && error.message ? error.message : error);
        res.status(500).json({ error: error.message });
     }
}

export async function listSessions(req, res) {
    try {
        const userId = req.user.id;
        const sessions = await authService.listSessionsForUser(userId);
        res.status(200).json({ sessions });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}

export async function revokeSession(req, res) {
    try {
        const userId = req.user.id;
        const { selector } = req.body;
        if (!selector) return res.status(400).json({ error: 'selector required' });
        const ok = await authService.revokeSessionBySelector(userId, selector);
        if (!ok) return res.status(404).json({ error: 'session not found or not owned by user' });
        res.status(204).send();
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
}
