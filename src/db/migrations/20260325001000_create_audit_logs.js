/**
 * Create audit_logs table to record ownership changes, deletes, and restores
 */
export async function up(knex) {
  return knex.schema.createTable("audit_logs", (table) => {
    table.uuid("id").primary();
    table.string("entity_type").notNullable(); // 'user'|'organization'|'membership'|etc
    table.uuid("entity_id").nullable();
    table.string("action").notNullable(); // e.g., 'owner_promoted','organization_soft_deleted','user_restored'
    table.text("details").nullable(); // JSON string with extra context
    table.uuid("performed_by").nullable();
    table.timestamp("created_at").defaultTo(knex.fn.now());
  });
}

export async function down(knex) {
  return knex.schema.dropTable("audit_logs");
}
