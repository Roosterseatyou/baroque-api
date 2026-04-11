/**
 * Create collections table and add collection_id FK to pieces
 */
export async function up(knex) {
  await knex.schema.createTable("collections", (table) => {
    table.uuid("id").primary();
    table.uuid("library_id").notNullable();
    table
      .foreign("library_id")
      .references("id")
      .inTable("libraries")
      .onDelete("CASCADE");
    table.string("name").notNullable();
    table.string("library_number").nullable(); // a collection-level library number
    table.json("metadata").nullable();
    table.timestamp("created_at").defaultTo(knex.fn.now());
    table.timestamp("updated_at").defaultTo(knex.fn.now());
  });

  await knex.schema.alterTable("pieces", (table) => {
    table.uuid("collection_id").nullable();
    table
      .foreign("collection_id")
      .references("id")
      .inTable("collections")
      .onDelete("SET NULL");
  });
}

export async function down(knex) {
  await knex.schema.alterTable("pieces", (table) => {
    table.dropForeign("collection_id");
    table.dropColumn("collection_id");
  });
  await knex.schema.dropTableIfExists("collections");
}
