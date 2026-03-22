/**
 * Make oauth_info columns `avatar_url` and `provider_user_id` nullable to allow insertion
 * when provider doesn't return those fields.
 * @param { import("knex").Knex } knex
 */
export async function up(knex) {
  return knex.schema.alterTable('oauth_info', table => {
    table.string('avatar_url').nullable().alter()
    table.string('provider_user_id').nullable().alter()
  })
}

export async function down(knex) {
  return knex.schema.alterTable('oauth_info', table => {
    table.string('avatar_url').notNullable().alter()
    table.string('provider_user_id').notNullable().alter()
  })
}
