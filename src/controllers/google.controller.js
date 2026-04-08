import * as googleService from '../services/google.service.js'
import * as authService from '../services/auth.service.js'
import * as googleAuthService from '../services/googleAuth.service.js'
import knex from '../config/knex.js'
import { google } from 'googleapis'
import debug from '../utils/debug.js'

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI, FRONTEND_ORIGIN } = process.env

function makeOAuth2Client() {
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI)
}

export async function authorize(req, res) {
  try {
    const user = req.user
    if (!user || !user.id) return res.status(401).json({ error: 'Unauthorized' })

    const state = Math.random().toString(36).slice(2)
    const redirectTo = req.query.redirect || '/'
    // persist server-side
    await knex('oauth_states').insert({ state, user_id: user.id, redirect_to: redirectTo })

    // Use the same ENV-configurable scopes as the SPA sign-in flow.
    const DEFAULT_SCOPES = [
      'openid',
      'email',
      'profile'
    ]
    const raw = process.env.GOOGLE_OAUTH_SCOPES || DEFAULT_SCOPES.join(' ')
    // For integrations/linking flow, allow include_granted_scopes=true so existing grants are honored
    const url = googleAuthService.getGoogleAuth(state, raw, true)

    const accept = (req.get('Accept') || '')
    if (accept.includes('application/json') || req.xhr) {
      return res.json({ url })
    }
    return res.redirect(url)
  } catch (err) {
    console.error('google.authorize error', err && err.stack ? err.stack : err)
    res.status(500).json({ error: err.message })
  }
}

export async function callback(req, res) {
  try {
    debug.debugLog('google.callback invoked:', { url: req.originalUrl, path: req.path, cookiesHeader: req.headers && req.headers.cookie ? req.headers.cookie : null });
    const { code, state } = req.query
    if (!code) return res.status(400).json({ error: 'code missing' })

    // lookup persisted state
    const record = await knex('oauth_states').where({ state }).first()
    if (!record) {
      console.warn('google.callback: no oauth_states record for state:', state)
    }

    const oAuth2Client = makeOAuth2Client()
    const { tokens } = await oAuth2Client.getToken(code);

    // upsert into oauth_info table for the userId
    let userId = record ? record.user_id : null
    // fetch userinfo to allow mapping or creation
    let ui = null
    try {
      oAuth2Client.setCredentials(tokens)
      const oauth2 = google.oauth2({ auth: oAuth2Client, version: 'v2' })
      const uiResp = await oauth2.userinfo.get()
      ui = uiResp && uiResp.data ? uiResp.data : null
    } catch (e) {
      console.warn('google.callback: failed to fetch userinfo', e && e.message)
    }

    const email = ui && ui.email
    const providerUserId = ui && (ui.sub || ui.id)
    const name = ui && ui.name
    const avatarUrl = ui && ui.picture

    // Prefer mapping via existing oauth_info record (provider_user_id) earlier handled above.
    // If no mapping, attempt to match by username base derived from email local-part as a fallback.
    if (!userId && email) {
      try {
        const base = email.split('@')[0];
        const userRow = await knex('users').whereRaw('LOWER(username) = LOWER(?)', [base]).first();
        if (userRow) {
          userId = userRow.id
          debug.debugLog('google.callback: mapped to user by username base from email', base, userId)
        } else {
          console.warn('google.callback: no local user for google email-derived username', base)
        }
      } catch (e) {
        console.warn('google.callback: failed to lookup user by derived username', e && e.message)
      }
    }

    // Optionally allow creating a new local user on OAuth sign-up (opt-in via env)
    if (!userId && process.env.ALLOW_GOOGLE_SIGNUP === 'true') {
      try {
        const created = await authService.createOrFindUserByGoogle({
          googleId: providerUserId,
          email,
          name,
          avatarUrl,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token
        })
        if (created && created.id) {
          userId = created.id
          debug.debugLog('google.callback: created local user for google sign-up', userId)
        }
      } catch (e) {
        console.warn('google.callback: failed to create local user from google profile', e && e.message)
      }
    }

    if (userId) {
      const existing = await knex('oauth_info').where({ user_id: userId, provider: 'google' }).first()
      if (existing) {
        await knex('oauth_info').where({ id: existing.id }).update({ access_token: tokens.access_token || null, refresh_token: tokens.refresh_token || existing.refresh_token || null, token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date) : null, updated_at: knex.fn.now() })
      } else {
        await knex('oauth_info').insert({ id: (await import('../utils/uuid.js')).generateUUID(), user_id: userId, email: email || null, provider: 'google', provider_user_id: providerUserId || null, avatar_url: avatarUrl || null, access_token: tokens.access_token || null, refresh_token: tokens.refresh_token || null, token_expires_at: tokens.expiry_date ? new Date(tokens.expiry_date) : null, created_at: knex.fn.now(), updated_at: knex.fn.now() })
      }
      // create a server-side refresh token and set HttpOnly cookie so SPA can call /auth/refresh
      try {
        const metadata = { ip: req.ip, userAgent: req.get('user-agent') }
        const refresh = await authService.createRefreshTokenForUser(userId, 30, metadata)
        const REFRESH_COOKIE_NAME = 'refresh_token'
        // Add per-request cookie options for refresh token to ensure cookie is set in local vs prod
        // Helper: build effective refresh cookie options for this request (local vs prod)
        function buildRefreshCookieOptions(frontendOrigin) {
          const isLocal = frontendOrigin && (frontendOrigin.includes('localhost') || frontendOrigin.includes('127.0.0.1')) || process.env.NODE_ENV !== 'production';
          const opts = {
              httpOnly: true,
              secure: process.env.NODE_ENV === 'production',
              sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
              path: '/',
          };
          if (isLocal) {
              opts.sameSite = 'lax';
              opts.secure = false;
          } else {
              opts.sameSite = 'none';
              opts.secure = true;
          }
          return opts;
        }
        try {
          const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';
          const cookieOpts = buildRefreshCookieOptions(FRONTEND_ORIGIN);
          if (process.env.DEBUG_OAUTH === 'true') {
            debug.debugLog('google.callback: setting refresh cookie', { name: REFRESH_COOKIE_NAME, valueSnippet: (refresh.token || '').slice(0,8) + '...', options: cookieOpts, userId });
          }
          res.cookie(REFRESH_COOKIE_NAME, refresh.token, cookieOpts);
        } catch (e) {
          console.warn('Failed to set refresh cookie', e && e.message)
        }
        if (process.env.DEBUG_OAUTH === 'true') {
          debug.debugLog('google.callback: set refresh cookie for user', userId)
        }
      } catch (e) {
        console.warn('Failed to create server refresh token after google callback', e && e.message)
      }
    } else {
      console.warn('google.callback: userId still unknown; tokens will not be persisted to oauth_info')
    }

    // cleanup the state record
    try { await knex('oauth_states').where({ state }).del() } catch(e){}

    const redirectTo = record && record.redirect_to ? record.redirect_to : '/'
    // Redirect to the SPA oauth-callback route which the frontend already handles
    const redirectUrl = `${FRONTEND_ORIGIN || 'http://localhost:5173'}/oauth-callback?connected=google&redirect=${encodeURIComponent(redirectTo)}`
    return res.redirect(redirectUrl)
  } catch (err) {
    console.error('google.callback error', err && err.stack ? err.stack : err)
    res.status(500).json({ error: err.message })
  }
}

// Spreadsheet listing and fetching endpoints were removed to comply with reduced
// Google OAuth scopes (no Drive/Sheets access). The rest of the OAuth flow
// (authorize, callback, token persistence) remains functional for Google sign-in.

export async function status(req, res) {
  try {
    const userId = req.user && req.user.id
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })
    const row = await knex('oauth_info').where({ user_id: userId, provider: 'google' }).first()
    if (!row) return res.json({ connected: false })
    // mask tokens
    const hasAccess = !!row.access_token
    const hasRefresh = !!row.refresh_token
    return res.json({ connected: true, hasAccess, hasRefresh, email: row.email || null })
  } catch (err) {
    console.error('google.status error', err)
    res.status(500).json({ error: err.message })
  }
}

// Dev-only debug: return oauth_info metadata for current user (masked)
export async function debugInfo(req, res) {
  try {
    // Only enabled in non-production to avoid accidental exposure
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found' })
    const userId = req.user && req.user.id
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })
    const row = await knex('oauth_info').where({ user_id: userId, provider: 'google' }).first()
    if (!row) return res.status(404).json({ error: 'No google oauth info for user' })
    return res.json({
      id: row.id,
      user_id: row.user_id,
      email: row.email,
      provider_user_id: row.provider_user_id,
      avatar_url: row.avatar_url,
      hasAccess: !!row.access_token,
      hasRefresh: !!row.refresh_token,
      token_expires_at: row.token_expires_at
    })
  } catch (err) {
    console.error('google.debugInfo error', err)
    res.status(500).json({ error: err.message })
  }
}

// Dev-only: fetch tokeninfo for the stored access_token to inspect granted scopes
export async function tokenInfo(req, res) {
  try {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found' })
    const userId = req.user && req.user.id
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })
    const row = await knex('oauth_info').where({ user_id: userId, provider: 'google' }).first()
    if (!row || !row.access_token) return res.status(404).json({ error: 'No access token found' })

    // Use Google's tokeninfo endpoint to inspect scopes without exposing tokens in logs
    const token = row.access_token
    const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`)
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      return res.status(resp.status).json({ error: `tokeninfo returned ${resp.status}`, body: text })
    }
    const info = await resp.json()
    // return a minimal view
    return res.json({ scopes: info.scope || null, expires_in: info.expires_in || null, audience: info.aud || null })
  } catch (err) {
    console.error('google.tokenInfo error', err && err.message ? err.message : err)
    res.status(500).json({ error: err.message })
  }
}

// Dev-only: reset stored oauth_info for current user (delete row) — useful to force a fresh grant. Disabled in production.
export async function resetConnection(req, res) {
  try {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found' })
    const userId = req.user && req.user.id
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })
    const row = await knex('oauth_info').where({ user_id: userId, provider: 'google' }).first()
    if (!row) return res.status(404).json({ error: 'No google oauth info for user' })
    await knex('oauth_info').where({ id: row.id }).del()
    return res.json({ success: true })
  } catch (err) {
    console.error('google.resetConnection error', err)
    res.status(500).json({ error: err.message })
  }
}

// Dev-only: list recent oauth_states rows for debugging
export async function listOauthStates(req, res) {
  try {
    if (process.env.NODE_ENV === 'production') return res.status(404).json({ error: 'Not found' })
    const rows = await knex('oauth_states').select('state','user_id','redirect_to','created_at').orderBy('created_at','desc').limit(20)
    return res.json({ states: rows })
  } catch (err) {
    console.error('google.listOauthStates error', err)
    res.status(500).json({ error: err.message })
  }
}
