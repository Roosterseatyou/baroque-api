require('dotenv').config();

const defaultConnection = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

const testConnection = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  // Allow an explicit DB_NAME_TEST, otherwise fall back to a `${DB_NAME}_test` convention
  database: process.env.DB_NAME_TEST || (process.env.DB_NAME ? `${process.env.DB_NAME}_test` : undefined),
};

module.exports =  {
  development: {
    client: 'mysql',
    connection: defaultConnection,
    migrations: {
      directory: './src/db/migrations'
    }
  },
  test: {
    client: 'mysql',
    connection: testConnection,
    migrations: {
      directory: './src/db/migrations'
    }
  }
};
