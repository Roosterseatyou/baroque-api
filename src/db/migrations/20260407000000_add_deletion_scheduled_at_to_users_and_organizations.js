/**
 * Add deletion_scheduled_at nullable timestamp to users and organizations to support scheduled hard deletes
 */
export async function up(knex) {
  await knex.schema.table("users", (table) => {
    table.timestamp("deletion_scheduled_at").nullable();
  });
  await knex.schema.table("organizations", (table) => {
    table.timestamp("deletion_scheduled_at").nullable();
  });
}

export async function down(knex) {
  await knex.schema.table("users", (table) => {
    table.dropColumn("deletion_scheduled_at");
  });
  await knex.schema.table("organizations", (table) => {
    table.dropColumn("deletion_scheduled_at");
  });
}
