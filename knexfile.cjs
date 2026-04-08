require('dotenv').config();

// Support a single DATABASE_URL (e.g. mysql://user:pass@host:port/db) or the classic
// DB_HOST / DB_USER / DB_PASSWORD / DB_NAME environment variables.
function connectionFor(databaseName) {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  return {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: databaseName,
  };
}

const defaultConnection = connectionFor(process.env.DB_NAME);
const testConnection = connectionFor(process.env.DB_NAME_TEST || (process.env.DB_NAME ? `${process.env.DB_NAME}_test` : undefined));

module.exports = {
  development: {
    client: 'mysql2',
    connection: defaultConnection,
    migrations: {
      directory: './src/db/migrations'
    }
  },
  test: {
    client: 'mysql2',
    connection: testConnection,
    migrations: {
      directory: './src/db/migrations'
    }
  }
};
