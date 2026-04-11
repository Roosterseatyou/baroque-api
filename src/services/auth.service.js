import db from "../config/knex.js";
import * as usersService from "./users.service.js";
import { generateUUID } from "../utils/uuid.js";
import { comparePassword, hashPassword } from "../utils/hash.js";
import { generateAccessToken } from "../utils/jwt.js";
import crypto from "crypto";
import debug from "../utils/debug.js";

// Helper to generate unique discriminator for a username (mirror logic from users.service)
async function generateUniqueDiscriminatorForUsername(username) {
  const canonical = String(username || "").toLowerCase();
  for (let attempt = 0; attempt < 50; attempt++) {
    const disc = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, "0");
    const existing = await db("users")
      .whereRaw("LOWER(username) = LOWER(?)", [canonical])
      .andWhere({ discriminator: disc })
      .first();
    if (!existing) return disc;
  }
  for (let i = 0; i < 10000; i++) {
    const disc = String(i).padStart(4, "0");
    const existing = await db("users")
      .whereRaw("LOWER(username) = LOWER(?)", [canonical])
      .andWhere({ discriminator: disc })
      .first();
    if (!existing) return disc;
  }
  throw new Error("Unable to generate unique discriminator");
}

export async function registerUser({ username, name, password, email }) {
  const canonical = String(username || "").toLowerCase();
  const existingUser = await db("users")
    .whereRaw("LOWER(username) = LOWER(?)", [canonical])
    .first();
  if (existingUser) {
    throw new Error("User already exists");
  }

  // If email provided, ensure uniqueness
  if (email) {
    const existingEmail = await db("users")
      .whereRaw("LOWER(email) = LOWER(?)", [String(email).toLowerCase()])
      .first();
    if (existingEmail) {
      throw new Error("Email already in use");
    }
  }

  const id = generateUUID();
  const hashedPassword = await hashPassword(password);

  // generate a unique 4-digit discriminator server-side (do not allow client-controlled discriminator)
  const discriminator = await generateUniqueDiscriminatorForUsername(canonical);

  await db("users").insert({
    id,
    username: canonical,
    discriminator,
    name,
    password: hashedPassword,
    email: email ? String(email).toLowerCase() : null,
  });

  return {
    id,
    username: canonical,
    name,
    email: email ? String(email).toLowerCase() : null,
  };
}

function generateRandomString(bytes = 24) {
  return crypto.randomBytes(bytes).toString("hex");
}

function splitSelectorVerifier(cookieValue) {
  if (!cookieValue) return null;
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;
  return { selector: parts[0], verifier: parts[1] };
}

export async function createRefreshTokenForUser(
  userId,
  ttlDays = 30,
  metadata = {},
) {
  const selector = generateRandomString(9); // 18 hex chars
  const verifierRaw = generateRandomString(48); // 96 hex chars
  const verifierHash = await hashPassword(verifierRaw);

  const id = generateUUID();
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  const row = {
    id,
    user_id: userId,
    selector,
    token: verifierHash,
    expires_at: expiresAt,
    ip: metadata.ip || null,
    user_agent: metadata.userAgent || null,
  };
  await db("refresh_tokens").insert(row);

  const cookieValue = `${selector}.${verifierRaw}`;
  return { token: cookieValue, expires_at: expiresAt };
}

export async function revokeRefreshToken(cookieValue) {
  const parsed = splitSelectorVerifier(cookieValue);
  if (!parsed) return;
  await db("refresh_tokens")
    .where({ selector: parsed.selector })
    .update({
      revoked: true,
      revoked_at: new Date(),
      revoked_reason: "user_logout",
    });
}

export async function revokeAllRefreshTokensForUser(
  userId,
  reason = "compromise_detected",
) {
  await db("refresh_tokens")
    .where({ user_id: userId })
    .update({ revoked: true, revoked_at: new Date(), revoked_reason: reason });
}

export async function loginUser({ email, password }, metadata = {}) {
  // "email" parameter is treated as the user-supplied identifier which may be:
  // - an email address
  // - a username#discriminator handle (e.g. 'alice#0123')
  // - a bare username (e.g. 'alice')
  // To avoid authenticating an arbitrary user when usernames are not globally unique,
  // require the discriminator when the bare username maps to multiple accounts.
  if (!email) throw new Error("Email or username required");
  const identifier = String(email).trim();

  let user = null;

  // If input contains an @ treat as email
  if (identifier.includes("@")) {
    const canonicalEmail = identifier.toLowerCase();
    user = await db("users")
      .whereRaw("LOWER(email) = LOWER(?)", [canonicalEmail])
      .first();
    if (!user) throw new Error("Invalid email or password");
  } else if (identifier.includes("#")) {
    // username#discriminator
    const parts = identifier.split("#");
    const usernamePart = parts[0] || "";
    const discPart = parts[1] || "";
    if (!usernamePart || !discPart)
      throw new Error("Invalid username handle format; use username#1234");
    user = await db("users")
      .whereRaw("LOWER(username) = LOWER(?)", [usernamePart.toLowerCase()])
      .andWhere({ discriminator: discPart })
      .first();
    if (!user) throw new Error("Invalid username or password");
  } else {
    // bare username: ensure it maps to exactly one account, otherwise require discriminator
    const matches = await db("users")
      .whereRaw("LOWER(username) = LOWER(?)", [identifier.toLowerCase()])
      .select("*");
    if (!matches || matches.length === 0) {
      throw new Error("Invalid username or password");
    }
    if (matches.length > 1) {
      // Ambiguous: multiple users share this username (discriminator required)
      throw new Error("Ambiguous username; please login using username#1234");
    }
    user = matches[0];
  }

  const isPasswordValid = await comparePassword(password, user.password);
  if (!isPasswordValid) {
    throw new Error("Invalid username or password");
  }

  // If user was soft-deleted, restore them and mark as restored so caller can notify
  let restored = false;
  let effectiveUser = user;
  if (user.deleted_at) {
    try {
      await usersService.restoreUser(user.id);
      restored = true;
      // re-fetch user after restore to get updated fields
      effectiveUser = await db("users").where({ id: user.id }).first();
    } catch (e) {
      // if restore fails, continue with original user (authentication still allowed)
      effectiveUser = user;
    }
  }

  const payload = {
    id: effectiveUser.id,
    username: effectiveUser.username,
    discriminator: effectiveUser.discriminator,
  };
  const accessToken = generateAccessToken(payload);

  const refreshToken = await createRefreshTokenForUser(user.id, 30, metadata);

  const safeUser = {
    id: effectiveUser.id,
    username: effectiveUser.username,
    discriminator: effectiveUser.discriminator,
    name: effectiveUser.name,
    avatar_url: effectiveUser.avatar_url,
    email: effectiveUser.email || null,
  };
  if (restored) safeUser.restored = true;

  return {
    token: accessToken,
    refreshToken: refreshToken.token,
    refresh_expires_at: refreshToken.expires_at,
    user: safeUser,
    restored,
  };
}

export async function exchangeRefreshToken(
  cookieValue,
  rotate = true,
  metadata = {},
) {
  const parsed = splitSelectorVerifier(cookieValue);
  if (!parsed) {
    debug.debugLog("exchangeRefreshToken: malformed refresh cookie");
    return null;
  }
  const row = await db("refresh_tokens")
    .where({ selector: parsed.selector })
    .first();
  if (!row) {
    debug.debugLog(
      "exchangeRefreshToken: no db row for selector",
      parsed.selector,
    );
    return null;
  }
  if (row.revoked) {
    // If token already revoked, this is reuse attempt — revoke all tokens for user
    debug.debugLog(
      "exchangeRefreshToken: token revoked for selector",
      parsed.selector,
    );
    await revokeAllRefreshTokensForUser(row.user_id, "reuse_after_revocation");
    return null;
  }
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    debug.debugLog(
      "exchangeRefreshToken: token expired for selector",
      parsed.selector,
    );
    await db("refresh_tokens").where({ selector: parsed.selector }).del();
    return null;
  }

  const ok = await comparePassword(parsed.verifier, row.token);
  if (!ok) {
    // verifier mismatch but selector exists: possible theft — revoke all tokens for user
    debug.debugLog(
      "exchangeRefreshToken: verifier mismatch for selector",
      parsed.selector,
    );
    await revokeAllRefreshTokensForUser(row.user_id, "verifier_mismatch");
    await db("refresh_tokens").where({ selector: parsed.selector }).del();
    return null;
  }

  const user = await db("users").where({ id: row.user_id }).first();
  if (!user) return null;

  const accessToken = generateAccessToken({
    id: user.id,
    username: user.username,
    discriminator: user.discriminator,
  });

  // auto-restore soft-deleted users on refresh
  let restored = false;
  let effectiveUser = user;
  if (user.deleted_at) {
    try {
      await usersService.restoreUser(user.id);
      restored = true;
      effectiveUser = await db("users").where({ id: user.id }).first();
    } catch (e) {
      effectiveUser = user;
    }
  }

  if (rotate) {
    const newRefresh = await createRefreshTokenForUser(user.id, 30, metadata);
    // mark old token as revoked and delete it (we set revoked flag and then delete the row to avoid reuse)
    await db("refresh_tokens")
      .where({ selector: parsed.selector })
      .update({
        revoked: true,
        revoked_at: new Date(),
        revoked_reason: "rotated",
      });
    await db("refresh_tokens").where({ selector: parsed.selector }).del();
    const safeUser = {
      id: effectiveUser.id,
      username: effectiveUser.username,
      discriminator: effectiveUser.discriminator,
      name: effectiveUser.name,
      avatar_url: effectiveUser.avatar_url,
      email: effectiveUser.email || null,
    };
    if (restored) safeUser.restored = true;
    return {
      accessToken,
      user: safeUser,
      refreshToken: newRefresh.token,
      refresh_expires_at: newRefresh.expires_at,
      restored,
    };
  }

  const safeUser = {
    id: effectiveUser.id,
    username: effectiveUser.username,
    discriminator: effectiveUser.discriminator,
    name: effectiveUser.name,
    avatar_url: effectiveUser.avatar_url,
  };
  if (restored) safeUser.restored = true;
  return { accessToken, user: safeUser, restored };
}

export async function createOrFindUserByGoogle(profile) {
  const { googleId, email, name, avatarUrl, accessToken, refreshToken } =
    profile;
  const existingOAuth = await db("oauth_info")
    .where({ provider: "google", provider_user_id: googleId })
    .first();

  if (existingOAuth) {
    return db("users").where({ id: existingOAuth.user_id }).first();
  }

  // Try to find a user by verified email first (safer than matching username local-part).
  // If not found, create a new user. When creating, generate a sanitized username base
  // (prefer email local-part, then name) and retry discriminator generation + insert
  // to avoid unique-constraint races.
  let user = null;
  const emailLower = email ? String(email).toLowerCase() : null;
  if (emailLower) {
    user = await db("users")
      .whereRaw("LOWER(email) = LOWER(?)", [emailLower])
      .first();
  }

  if (!user) {
    const userId = generateUUID();

    // Choose a username base: prefer email local part, then name, then 'user'
    const localPart = emailLower ? emailLower.split("@")[0] : null;
    let base =
      (localPart || name || "user")
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "")
        .slice(0, 28) || "user";

    // Try inserting with generated discriminators, retrying on unique-constraint failures
    let inserted = false;
    let lastErr = null;
    const maxAttempts = 5;
    for (let attempt = 0; attempt < maxAttempts && !inserted; attempt++) {
      const disc = await generateUniqueDiscriminatorForUsername(base);
      try {
        await db("users").insert({
          id: userId,
          username: base,
          discriminator: disc,
          name,
          avatar_url: avatarUrl,
          email: emailLower || null,
        });
        inserted = true;
      } catch (err) {
        lastErr = err;
        // If error looks like a unique constraint violation on (username, discriminator),
        // retry (another discriminator). For other errors, rethrow.
        const msg = err && err.message ? String(err.message).toLowerCase() : "";
        const code = err && err.code ? String(err.code) : "";
        const isUniqueErr =
          msg.includes("unique") ||
          msg.includes("duplicate") ||
          code === "23505" ||
          code === "ER_DUP_ENTRY" ||
          code === "SQLITE_CONSTRAINT";
        if (!isUniqueErr) throw err;
        // otherwise loop and try a new discriminator
      }
    }
    if (!inserted) {
      throw lastErr || new Error("Failed to create user");
    }
    user = await db("users").where({ id: userId }).first();
  }
  await db("oauth_info").insert({
    id: generateUUID(),
    user_id: user.id,
    email: email || null,
    provider: "google",
    provider_user_id: googleId,
    avatar_url: avatarUrl,
    access_token: accessToken,
    refresh_token: refreshToken,
  });
  return user;
}

export async function listSessionsForUser(userId) {
  // Return non-deleted tokens; keep revoked status for display
  const rows = await db("refresh_tokens")
    .where({ user_id: userId })
    .select(
      "id",
      "selector",
      "created_at",
      "expires_at",
      "revoked",
      "revoked_at",
      "revoked_reason",
      "ip",
      "user_agent",
    );
  return rows;
}

export async function revokeSessionBySelector(userId, selector) {
  // Only allow revoking tokens that belong to the user
  const row = await db("refresh_tokens").where({ selector }).first();
  if (!row) return false;
  if (row.user_id !== userId) return false;
  await db("refresh_tokens")
    .where({ selector })
    .update({
      revoked: true,
      revoked_at: new Date(),
      revoked_reason: "user_revoked",
    });
  await db("refresh_tokens").where({ selector }).del();
  return true;
}
