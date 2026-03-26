/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function up(knex) {
  await knex.schema.createTable('duplicate_scan_jobs', function(table) {
    table.increments('id').primary();
    table.string('library_id').notNullable().index();
    table.enu('status', ['pending', 'running', 'done', 'failed']).notNullable().defaultTo('pending');
    table.json('result').nullable();
    table.bigInteger('cached_at').nullable();
    table.integer('attempts').notNullable().defaultTo(0);
    table.text('last_error').nullable();
    table.timestamp('started_at').nullable();
    table.timestamp('finished_at').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });
}

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
export async function down(knex) {
  await knex.schema.dropTableIfExists('duplicate_scan_jobs');
}

