/**
 * Add deleted_at nullable timestamp to users and organizations to support soft deletes
 */
export async function up(knex) {
  await knex.schema.table('users', table => {
    table.timestamp('deleted_at').nullable();
  });
  await knex.schema.table('organizations', table => {
    table.timestamp('deleted_at').nullable();
  });
}

export async function down(knex) {
  await knex.schema.table('users', table => {
    table.dropColumn('deleted_at');
  });
  await knex.schema.table('organizations', table => {
    table.dropColumn('deleted_at');
  });
}

