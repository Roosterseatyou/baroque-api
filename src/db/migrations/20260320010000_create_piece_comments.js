/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  return knex.schema.createTable("piece_comments", (table) => {
    table.uuid("id").primary();
    table.uuid("piece_id").notNullable();
    table.uuid("user_id").notNullable();
    table.text("content").notNullable();
    table.timestamp("created_at").defaultTo(knex.fn.now());

    table
      .foreign("piece_id")
      .references("id")
      .inTable("pieces")
      .onDelete("CASCADE");
    table
      .foreign("user_id")
      .references("id")
      .inTable("users")
      .onDelete("CASCADE");
  });
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  return knex.schema.dropTableIfExists("piece_comments");
}
