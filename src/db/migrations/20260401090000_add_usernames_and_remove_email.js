/**
 * Migration: add username and discriminator to users and backfill values.
 * NOTE: This migration intentionally does NOT remove the `email` column.
 */
export async function up(knex) {
  const hasUsername = await knex.schema.hasColumn("users", "username");
  const hasDiscriminator = await knex.schema.hasColumn(
    "users",
    "discriminator",
  );
  if (!hasUsername || !hasDiscriminator) {
    await knex.schema.alterTable("users", (table) => {
      if (!hasUsername) table.string("username", 50).nullable();
      if (!hasDiscriminator) table.string("discriminator", 4).nullable();
    });

    // Backfill username/discriminator for existing rows that lack them
    const users = await knex("users").select("id", "email");

    function sanitizeLocalPart(s) {
      if (!s) return "user";
      const t = String(s)
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "");
      return t.length ? t.slice(0, 30) : "user";
    }

    for (const u of users) {
      const local = sanitizeLocalPart((u.email || "").split("@")[0]);
      let base = local || "user";
      let disc = null;
      // try a number of attempts to find a free combination
      for (let attempt = 0; attempt < 1000; attempt++) {
        const candidateDisc = Math.floor(Math.random() * 10000)
          .toString()
          .padStart(4, "0");
        const exists = await knex("users")
          .whereRaw("LOWER(username) = LOWER(?) AND discriminator = ?", [
            base,
            candidateDisc,
          ])
          .first();
        if (!exists) {
          disc = candidateDisc;
          break;
        }
        // if base collides often, slightly alter base after some attempts
        if (attempt % 50 === 0)
          base = (base + Math.floor(Math.random() * 9)).slice(0, 30);
      }
      if (!disc)
        disc = Math.floor(Math.random() * 10000)
          .toString()
          .padStart(4, "0");
      await knex("users")
        .where({ id: u.id })
        .update({ username: base, discriminator: disc });
    }

    // Make columns NOT NULL and add unique index on (username, discriminator)
    await knex.schema.alterTable("users", (table) => {
      table.string("username", 50).notNullable().alter();
      table.string("discriminator", 4).notNullable().alter();
      try {
        table.unique(
          ["username", "discriminator"],
          "users_username_discriminator_unique",
        );
      } catch (e) {
        // ignore if index exists or DB doesn't support creating it here
      }
    });
  }
}

export async function down(knex) {
  const hasUsername = await knex.schema.hasColumn("users", "username");
  const hasDiscriminator = await knex.schema.hasColumn(
    "users",
    "discriminator",
  );
  if (hasUsername || hasDiscriminator) {
    await knex.schema.alterTable("users", (table) => {
      try {
        table.dropUnique(
          ["username", "discriminator"],
          "users_username_discriminator_unique",
        );
      } catch (e) {}
      if (hasUsername) table.dropColumn("username");
      if (hasDiscriminator) table.dropColumn("discriminator");
    });
  }
}
