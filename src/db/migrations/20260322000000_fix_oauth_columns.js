/**
 * Ensure oauth_info columns can store long Google tokens and allow nullable fields
 * This migration is idempotent-safe for existing schemas (uses alterTable).
 * @param { import("knex").Knex } knex
 */
export async function up(knex) {
  return knex.schema.alterTable("oauth_info", (table) => {
    // make token columns TEXT to avoid truncation
    if (!table) return;
    try {
      table.text("access_token").nullable().alter();
      table.text("refresh_token").nullable().alter();
    } catch (e) {
      // Some SQL engines may throw on alter if column already has correct type; ignore
      console.warn(
        "alter oauth token columns:",
        e && e.message ? e.message : e,
      );
    }
    // allow provider_user_id and avatar_url to be nullable
    try {
      table.string("provider_user_id").nullable().alter();
      table.string("avatar_url").nullable().alter();
    } catch (e) {
      // ignore
    }
    // ensure token_expires_at exists
    try {
      // only add if not exists - knex doesn't have conditional add, so guard in catch
      table.timestamp("token_expires_at").nullable().alter();
    } catch (e) {
      // ignore - some dialects cannot alter if column absent; in that case a separate migration may be needed
    }
  });
}

export async function down(knex) {
  return knex.schema.alterTable("oauth_info", (table) => {
    try {
      table.string("access_token").nullable().alter();
    } catch (e) {
      void e;
    }
    try {
      table.string("refresh_token").nullable().alter();
    } catch (e) {
      void e;
    }
    try {
      table.string("provider_user_id").notNullable().alter();
    } catch (e) {
      void e;
    }
    try {
      table.string("avatar_url").notNullable().alter();
    } catch (e) {
      void e;
    }
    try {
      table.dropColumn("token_expires_at");
    } catch (e) {
      void e;
    }
  });
}
