/**
 * Add view_token to libraries so a public view-only link can be shared
 */
export async function up(knex) {
  await knex.schema.alterTable("libraries", (table) => {
    table.string("view_token").nullable().unique();
    table.timestamp("view_token_created_at").nullable();
  });
}

export async function down(knex) {
  await knex.schema.alterTable("libraries", (table) => {
    try {
      table.dropColumn("view_token");
    } catch (e) {}
    try {
      table.dropColumn("view_token_created_at");
    } catch (e) {}
  });
}
