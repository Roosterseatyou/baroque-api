import * as authService from '../services/auth.service.js';
import * as googleAuthService from '../services/googleAuth.service.js';
import crypto from 'crypto';

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
    path: '/auth',
    maxAge: 10 * 60 * 1000 // 10 minutes
};

export async function register(req, res) {
    try {
        const { email, name, password } = req.body;
        const user = await authService.registerUser({ email, name, password });
        res.status(201).json(user);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
}

export async function login(req, res) {
    try {
        const { email, password } = req.body;
        const metadata = { ip: req.ip, userAgent: req.get('user-agent') };
        const { token, refreshToken, refresh_expires_at, user } = await authService.loginUser({ email, password }, metadata);
        // set refresh token as httpOnly cookie
        res.cookie(REFRESH_COOKIE_NAME, refreshToken, REFRESH_COOKIE_OPTIONS);
        res.status(200).json({ token, refresh_expires_at, user });
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
        res.cookie(REFRESH_COOKIE_NAME, result.refreshToken, REFRESH_COOKIE_OPTIONS);
        res.status(200).json({ token: result.accessToken, user: { id: result.user.id, email: result.user.email, name: result.user.name, avatar_url: result.user.avatar_url } });
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

    res.cookie(OAUTH_STATE_COOKIE, payload, cookieOptions);

    const url = googleAuthService.getGoogleAuth(state);
    return res.redirect(url);
}

export async function googleCallback(req, res) {
    try {
        if (process.env.NODE_ENV !== 'production') {
            try {
                console.log('auth.googleCallback invoked:', { url: req.originalUrl, path: req.path, cookiesHeader: req.headers && req.headers.cookie ? req.headers.cookie : null });
            } catch (e) {}
        }
        const { code, state } = req.query;
        if (!code) return res.status(400).json({ error: 'code not found' });
        // validate state from cookie (strict)
        const stateCookie = req.cookies && req.cookies[OAUTH_STATE_COOKIE];
        if (!stateCookie) {
            return res.status(400).json({ error: 'missing oauth state cookie' });
        }
        let parsed;
        try { parsed = JSON.parse(stateCookie); } catch (e) { parsed = null; }
        if (!parsed || parsed.state !== state) {
            return res.status(400).json({ error: 'invalid oauth state' });
        }
         // clear oauth state cookie (best-effort)
         try { res.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth' }); } catch(e) { /* ignore */ }

         const googleUser = await googleAuthService.exchangeCodeForUser(code);
         const user = await authService.createOrFindUserByGoogle(googleUser);

         // create server refresh token and set as HttpOnly cookie
         const metadata = { ip: req.ip, userAgent: req.get('user-agent') };
         const refresh = await authService.createRefreshTokenForUser(user.id, 30, metadata);
         res.cookie(REFRESH_COOKIE_NAME, refresh.token, REFRESH_COOKIE_OPTIONS);

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
