import db from "../config/knex.js";
import * as orgsService from "./orgs.service.js";
import * as auditService from "./audit.service.js";

export async function getUserById(userId) {
  const user = await db("users").where({ id: userId }).first();
  return user;
}

export async function getCurrentUser(userId) {
  return await getUserById(userId);
}

export async function getUserOrganizations(userId) {
  const organizations = await db("organization_memberships")
    .join(
      "organizations",
      "organization_memberships.organization_id",
      "organizations.id",
    )
    .where("organization_memberships.user_id", userId)
    .whereNull("organizations.deleted_at")
    .select(
      "organizations.*",
      "organization_memberships.role as membership_role",
    );
  return organizations;
}

// Helper: generate a unique 4-digit numeric discriminator for a username
async function generateUniqueDiscriminator(username) {
  const canonical = String(username || "").toLowerCase();
  // Try some random attempts first
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
  // Fallback to linear search
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

export async function updateUserProfile(
  userId,
  { name, username, discriminator, email } = {},
) {
  const update = {};

  // Load current user to decide whether discriminator assignment is needed
  const currentUser = await db("users").where({ id: userId }).first();
  if (!currentUser) throw new Error("User not found");

  if (typeof name !== "undefined") update.name = name;
  if (typeof username !== "undefined")
    update.username = String(username).toLowerCase();

  // Ignore client-provided discriminator. Server will assign one when appropriate.
  // If username changed or the user currently has no discriminator, generate one server-side.
  if (typeof username !== "undefined") {
    const newUsernameCanonical = String(username || "").toLowerCase();
    const currentUsernameCanonical = String(
      currentUser.username || "",
    ).toLowerCase();
    if (
      newUsernameCanonical !== currentUsernameCanonical ||
      !currentUser.discriminator
    ) {
      const disc = await generateUniqueDiscriminator(newUsernameCanonical);
      update.discriminator = disc;
    }
  } else if (!currentUser.discriminator) {
    // username unchanged but discriminator missing - generate one for existing username
    const disc = await generateUniqueDiscriminator(
      currentUser.username || currentUser.email?.split("@")[0] || "user",
    );
    update.discriminator = disc;
  }

  // Explicit email handling: validate and ensure uniqueness if provided
  if (typeof email !== "undefined") {
    if (email) {
      const emailStr = String(email).toLowerCase();
      // basic email format validation
      const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRe.test(emailStr)) throw new Error("Invalid email format");
      // ensure no other user has this email
      const existing = await db("users")
        .whereRaw("LOWER(email) = LOWER(?)", [emailStr])
        .andWhereNot({ id: userId })
        .first();
      if (existing) throw new Error("Email already in use");
      update.email = emailStr;
    } else {
      // explicit null to clear email
      update.email = null;
    }
  }

  if (Object.keys(update).length === 0) {
    return await getUserById(userId);
  }

  await db("users").where({ id: userId }).update(update);

  const updatedUser = await getUserById(userId);
  return updatedUser;
}

export async function deleteUser(userId) {
  // Deprecated simple delete. Use deleteUserData for the safe deletion flow.
  return deleteUserData(userId);
}

export async function createUserData(userId, { orgName } = {}) {
  // Create a default personal organization and return it. Uses orgsService.createOrganization
  const name = orgName || "Personal Organization";
  const org = await orgsService.createOrganization({ userId, name });
  return org;
}

export async function deleteUserData(userId) {
  // Safe deletion: schedule a hard delete for the user after a grace period and soft-delete the account now.
  // This preserves the ability to restore the account if the user signs in again within the grace period.
  const days = Number(process.env.USER_DELETION_GRACE_DAYS || 30);
  // Use DB function to compute timestamp in future (MySQL DATE_ADD). If not MySQL, environment should set appropriate behavior.
  const scheduledAt = db.raw("DATE_ADD(NOW(), INTERVAL ? DAY)", [days]);

  await db.transaction(async (trx) => {
    // Perform ownership transfer similar to prior behavior: if another admin exists, promote them; otherwise soft-delete the org and schedule its deletion
    const ownerRows = await trx("organization_memberships")
      .where({ user_id: userId, role: "owner" })
      .select("organization_id");

    for (const row of ownerRows) {
      const orgId = row.organization_id;
      const newOwner = await trx("organization_memberships")
        .where({ organization_id: orgId, role: "admin" })
        .andWhere("user_id", "<>", userId)
        .orderBy("created_at", "asc")
        .first();

      if (newOwner && newOwner.id) {
        await trx("organization_memberships")
          .where({ id: newOwner.id })
          .update({ role: "owner" });
        await auditService.writeAudit(
          {
            entityType: "membership",
            entityId: newOwner.id,
            action: "owner_promoted",
            details: {
              organization_id: orgId,
              promoted_user_id: newOwner.user_id,
            },
            performedBy: userId,
          },
          trx,
        );
      } else {
        // No admin found — soft-delete the organization and schedule hard deletion
        try {
          await trx("organizations")
            .where({ id: orgId })
            .update({
              deleted_at: trx.fn.now(),
              deleted_by: userId,
              deletion_scheduled_at: scheduledAt,
            });
          await auditService.writeAudit(
            {
              entityType: "organization",
              entityId: orgId,
              action: "organization_soft_deleted",
              details: {
                reason: "owner_deleted_no_admin",
                scheduled_days: days,
              },
              performedBy: userId,
            },
            trx,
          );
        } catch (e) {
          // fallback to hard delete if update fails for any reason — use service helper to remove all library data
          try {
            // Ensure we pass performedBy (null) and the transaction as the third argument
            // so the hard delete runs inside the current transaction and audit logs record the
            // correct performer (null in this fallback case).
            await orgsService.hardDeleteOrganization(orgId, null, trx);
          } catch (innerErr) {
            throw innerErr;
          }
        }
      }
    }

    // Remove any remaining memberships (organization_memberships, library_memberships)
    await trx("organization_memberships").where({ user_id: userId }).del();
    await trx("library_memberships").where({ user_id: userId }).del();

    // Remove oauth_info, refresh tokens, oauth_states related to this user
    try {
      await trx("oauth_info").where({ user_id: userId }).del();
    } catch (e) {
      /* ignore */
    }
    try {
      await trx("refresh_tokens").where({ user_id: userId }).del();
    } catch (e) {
      /* ignore */
    }
    try {
      await trx("oauth_states").where({ user_id: userId }).del();
    } catch (e) {
      /* ignore */
    }

    // Finally soft-delete the user record and set deletion_scheduled_at
    await trx("users")
      .where({ id: userId })
      .update({ deleted_at: trx.fn.now(), deletion_scheduled_at: scheduledAt });
    await auditService.writeAudit(
      {
        entityType: "user",
        entityId: userId,
        action: "user_soft_deleted",
        details: { scheduled_days: days },
        performedBy: userId,
      },
      trx,
    );
  });
}

export async function scheduleUserHardDelete(userId, when, performedBy = null) {
  await db("users")
    .where({ id: userId })
    .update({ deletion_scheduled_at: when });
  try {
    await auditService.writeAudit({
      entityType: "user",
      entityId: userId,
      action: "user_deletion_scheduled",
      details: { when },
      performedBy: performedBy || null,
    });
  } catch (e) {
    void e;
  }
}

export async function restoreUser(userId) {
  // Restore user and attempt to revert ownership promotions and restore orgs that were soft-deleted when the user was removed.
  return await db.transaction(async (trx) => {
    await trx("users")
      .where({ id: userId })
      .update({ deleted_at: null, updated_at: trx.fn.now() });
    await auditService.writeAudit(
      {
        entityType: "user",
        entityId: userId,
        action: "user_restored",
        details: null,
        performedBy: null,
      },
      trx,
    );

    // 1) Revert owner promotions that were recorded as performed_by = userId
    const promos = await trx("audit_logs")
      .where({ action: "owner_promoted", performed_by: userId })
      .select("id", "details", "created_at");
    for (const p of promos) {
      let details = null;
      try {
        details =
          typeof p.details === "string" ? JSON.parse(p.details) : p.details;
      } catch (e) {
        details = null;
      }
      if (!details || !details.organization_id || !details.promoted_user_id)
        continue;
      const orgId = details.organization_id;
      const promotedUserId = details.promoted_user_id;

      // Demote the promoted user back to 'admin' if they still have a membership
      try {
        const promotedMembership = await trx("organization_memberships")
          .where({ organization_id: orgId, user_id: promotedUserId })
          .first();
        if (promotedMembership) {
          await trx("organization_memberships")
            .where({ id: promotedMembership.id })
            .update({ role: "admin" });
        }

        // Ensure the restored user has an owner membership
        let restoreMembership = await trx("organization_memberships")
          .where({ organization_id: orgId, user_id: userId })
          .first();
        if (restoreMembership) {
          await trx("organization_memberships")
            .where({ id: restoreMembership.id })
            .update({ role: "owner" });
        } else {
          await trx("organization_memberships").insert({
            id: (await import("../utils/uuid.js")).generateUUID(),
            organization_id: orgId,
            user_id: userId,
            role: "owner",
          });
        }

        // Audit the revert
        try {
          await auditService.writeAudit(
            {
              entityType: "membership",
              entityId: promotedMembership ? promotedMembership.id : null,
              action: "owner_reverted",
              details: {
                organization_id: orgId,
                restored_owner_id: userId,
                demoted_user_id: promotedUserId,
                source_audit_id: p.id,
              },
              performedBy: userId,
            },
            trx,
          );
        } catch (e) {
          void e;
        }
      } catch (e) {
        // ignore individual failures and continue
      }
    }

    // 2) Restore organizations that were soft-deleted due to owner deletion (audit: organization_soft_deleted)
    const orgDeletes = await trx("audit_logs")
      .where({ action: "organization_soft_deleted", performed_by: userId })
      .select("id", "entity_id", "details");
    for (const od of orgDeletes) {
      let details = null;
      try {
        details =
          typeof od.details === "string" ? JSON.parse(od.details) : od.details;
      } catch (e) {
        details = null;
      }
      const orgId =
        od.entity_id || (details && details.organization_id) || null;
      if (!orgId) continue;
      try {
        await trx("organizations")
          .where({ id: orgId })
          .update({ deleted_at: null, updated_at: trx.fn.now() });
        await auditService.writeAudit(
          {
            entityType: "organization",
            entityId: orgId,
            action: "organization_restored_via_user_restore",
            details: { source_audit_id: od.id },
            performedBy: userId,
          },
          trx,
        );
      } catch (e) {
        // ignore and continue
      }
    }

    return true;
  });
}

export async function getUserLibraries(userId) {
  const libraries = await db("library_memberships")
    .join("libraries", "library_memberships.library_id", "libraries.id")
    .where("library_memberships.user_id", userId)
    .select("libraries.*", "library_memberships.role as membership_role");
  return libraries;
}

// find a user by username#discriminator or username
export async function getUserByHandle(handle) {
  if (!handle) return null;
  // accept either 'username#1234' or { username, discriminator }
  if (typeof handle === "string") {
    let username = handle;
    let discriminator = null;
    if (handle.includes("#")) {
      const parts = handle.split("#");
      username = parts[0];
      discriminator = parts[1];
    }
    const query = db("users").whereRaw("LOWER(username) = LOWER(?)", [
      username,
    ]);
    if (discriminator) query.andWhere({ discriminator });
    const user = await query.first();
    return user || null;
  }
  // if passed an object
  const { username, discriminator } = handle || {};
  if (!username) return null;
  const query = db("users").whereRaw("LOWER(username) = LOWER(?)", [username]);
  if (discriminator) query.andWhere({ discriminator });
  const user = await query.first();
  return user || null;
}

// Return organizations that were soft-deleted and attributed to actions performed by the given user.
// This uses audit_logs entries with action 'organization_soft_deleted' where performed_by = userId
// and returns the corresponding organizations (only those with deleted_at set).
export async function getDeletedOrganizationsForUser(userId) {
  // find audit log entries where this user performed an organization deletion (soft or hard)
  // or entries whose details mention the user id (some older flows may have stored user ids only in details)
  const rows = await db("audit_logs")
    .whereIn("action", [
      "organization_soft_deleted",
      "organization_deleted_hard",
    ])
    .andWhere(function () {
      this.where({ performed_by: userId }).orWhere(
        "details",
        "like",
        `%${userId}%`,
      );
    })
    .select("entity_id", "action", "details", "created_at");
  const orgIds = [...new Set(rows.map((r) => r.entity_id).filter(Boolean))];
  if (orgIds.length === 0) return [];

  // fetch only soft-deleted organization rows (exclude active/restored orgs and audit-only entries)
  const softDeletedOrgs = await db("organizations")
    .whereIn("id", orgIds)
    .whereNotNull("deleted_at")
    .select("*");

  // Return only actual soft-deleted (restorable) orgs
  return softDeletedOrgs.map((o) => ({
    id: o.id,
    name: o.name,
    deleted_at: o.deleted_at,
    restorable: true,
  }));
}
