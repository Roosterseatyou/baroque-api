export async function up(knex) {
  await knex.schema.createTable('invitations', (table) => {
    table.string('id').primary();
    table.string('organization_id').notNullable().index();
    table.string('invited_user_id').nullable().index(); // FK to users.id when known
    table.string('invited_username').nullable(); // store requested username handle or raw input
    table.string('invited_by_user_id').notNullable().index();
    table.string('role').notNullable().defaultTo('viewer');
    table.enu('status', ['pending','accepted','declined']).notNullable().defaultTo('pending');
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.timestamp('updated_at').defaultTo(knex.fn.now());
  });
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('invitations');
}

