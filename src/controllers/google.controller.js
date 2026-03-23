import * as googleService from '../services/google.service.js'
import * as authService from '../services/auth.service.js'
import knex from '../config/knex.js'
import { google } from 'googleapis'

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

    const oAuth2Client = makeOAuth2Client()
    const url = oAuth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: false,
      scope: [
        'openid',
        'email',
        'profile',
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/spreadsheets.readonly'
      ],
      state
    })

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
    if (process.env.NODE_ENV !== 'production') {
      try {
        console.log('google.callback invoked:', { url: req.originalUrl, path: req.path, cookiesHeader: req.headers && req.headers.cookie ? req.headers.cookie : null });
      } catch (e) {}
    }
    const { code, state } = req.query
    if (!code) return res.status(400).json({ error: 'code missing' })

    // lookup persisted state
    const record = await knex('oauth_states').where({ state }).first()
    if (!record) {
      console.warn('google.callback: no oauth_states record for state:', state)
    }

    const oAuth2Client = makeOAuth2Client()
    const { tokens } = await oAuth2Client.getToken(code); // Debug: log granted scopes and whether a refresh token was returned (do not log full tokens)
    try {
      const grantedScopes = tokens.scope || tokens.scopes || null
      const hasRefresh = !!tokens.refresh_token
      console.log('google.callback: token exchange result - scopes=', grantedScopes, 'hasRefresh=', hasRefresh)
    } catch (e) {
      // ignore logging failures
    }

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

    if (!userId && email) {
      try {
        const userRow = await knex('users').where({ email }).first()
        if (userRow) {
          userId = userRow.id
          console.log('google.callback: mapped to user by email', email, userId)
        } else {
          console.warn('google.callback: no local user for google email', email)
        }
      } catch (e) {
        console.warn('google.callback: failed to lookup user by email', e && e.message)
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
          console.log('google.callback: created local user for google sign-up', userId)
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
        const REFRESH_COOKIE_OPTIONS = {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          // Allow cross-site set-cookie on OAuth redirect in production
          sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
          // Use '/' so SPA can POST /auth/refresh and browser will include the cookie reliably
          path: '/'
        }
        try { res.cookie(REFRESH_COOKIE_NAME, refresh.token, REFRESH_COOKIE_OPTIONS) } catch (e) { console.warn('Failed to set refresh cookie', e && e.message) }
        console.log('google.callback: set refresh cookie for user', userId)
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

export async function listFiles(req, res) {
  try {
    const userId = req.user && req.user.id
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })
    const files = await googleService.listSpreadsheetsForUser(userId)
    res.json(files)
  } catch (err) {
    // log detailed error for debugging
    console.error('google.listFiles error - details:', {
      message: err && err.message,
      stack: err && err.stack,
      code: err && err.code,
      response: err && err.response && err.response.data ? err.response.data : undefined
    })

    // If service threw a clear "Google not connected" error
    const msg = String(err && err.message || '').toLowerCase()
    if (msg.includes('google not connected') || msg.includes('not connected')) {
      return res.status(400).json({ error: 'Google not connected for this user. Please connect Google.' })
    }

    // If the error indicates insufficient scopes or a 403 from Google, return 403 with actionable message
    if (err && (err.code === 403 || (err.response && err.response.status === 403) || msg.includes('insufficient') || msg.includes('drive') || msg.includes('sheets'))) {
      return res.status(403).json({ error: 'Google authorization missing required Drive/Sheets scopes. Please reconnect and grant Drive and Sheets access.' })
    }

    // fallback
    res.status(500).json({ error: err.message || 'Failed to list Google sheets' })
  }
}

export async function getMetadata(req, res) {
  try {
    const userId = req.user && req.user.id
    const { fileId } = req.params
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })
    if (!fileId) return res.status(400).json({ error: 'fileId required' })
    const meta = await googleService.getSpreadsheetMetadata(userId, fileId)
    res.json(meta)
  } catch (err) {
    console.error('google.getMetadata error', err && err.stack ? err.stack : err)
    res.status(500).json({ error: err.message })
  }
}

export async function getValues(req, res) {
  try {
    const userId = req.user && req.user.id
    const { fileId } = req.params
    const range = req.query.range || req.body.range || ''
    if (!userId) return res.status(401).json({ error: 'Unauthorized' })
    if (!fileId) return res.status(400).json({ error: 'fileId required' })
    const values = await googleService.getSpreadsheetValues(userId, fileId, range)
    res.json(values)
  } catch (err) {
    console.error('google.getValues error', err && err.stack ? err.stack : err)
    res.status(500).json({ error: err.message })
  }
}

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
