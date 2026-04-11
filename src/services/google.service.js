import { google } from "googleapis";
import db from "../config/knex.js";

const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } =
  process.env;

function makeOAuth2Client() {
  return new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI,
  );
}

async function getOauthRowForUser(userId) {
  const row = await db("oauth_info")
    .where({ user_id: userId, provider: "google" })
    .first();
  return row || null;
}

async function persistTokensForUser(userId, tokens) {
  const update = {};
  if (tokens.access_token) update.access_token = tokens.access_token;
  if (tokens.refresh_token) update.refresh_token = tokens.refresh_token;
  if (tokens.expiry_date) update.updated_at = db.fn.now();
  if (tokens.expiry_date)
    update.token_expires_at = new Date(tokens.expiry_date);
  if (Object.keys(update).length === 0) return;
  await db("oauth_info")
    .where({ user_id: userId, provider: "google" })
    .update(update);
}

export async function getOAuthClientForUser(userId) {
  const row = await getOauthRowForUser(userId);
  if (!row) return null;

  const oAuth2Client = makeOAuth2Client();
  const creds = {};
  if (row.access_token) creds.access_token = row.access_token;
  if (row.refresh_token) creds.refresh_token = row.refresh_token;
  if (row.token_expires_at)
    creds.expiry_date = new Date(row.token_expires_at).getTime();
  oAuth2Client.setCredentials(creds);

  // persist refreshed tokens when google auth library emits 'tokens'
  oAuth2Client.on("tokens", async (tokens) => {
    try {
      // tokens may include access_token, refresh_token, expiry_date
      await persistTokensForUser(userId, tokens);
    } catch (err) {
      console.warn(
        "Failed to persist refreshed Google tokens for user",
        userId,
        err && err.message,
      );
    }
  });

  return oAuth2Client;
}

// NOTE: Sheets-specific helpers were removed to comply with reduced Google OAuth scopes.
// The file retains OAuth client creation and token persistence helpers which are used
// by the rest of the application for Google sign-in/token management.
