export async function up(knex) {
  await knex.schema.alterTable("invitations", (table) => {
    table.string("invited_discriminator").nullable();
  });
}

export async function down(knex) {
  await knex.schema.alterTable("invitations", (table) => {
    table.dropColumn("invited_discriminator");
  });
}
