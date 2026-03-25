/**
 * Add deleted_by column to organizations to record who performed soft-deletes
 */
export async function up(knex) {
  await knex.schema.table('organizations', table => {
    table.uuid('deleted_by').nullable();
  });
}

export async function down(knex) {
  await knex.schema.table('organizations', table => {
    table.dropColumn('deleted_by');
  });
}

