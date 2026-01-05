import knex from 'knex';
import knexfile from '../../knexfile.cjs';

const environment = process.env.NODE_ENV || 'development';
const resolvedKnexfile = (knexfile && knexfile.default) ? knexfile.default : knexfile;
const config = resolvedKnexfile[environment] || resolvedKnexfile['development'];

const db = knex(config);

export default db;