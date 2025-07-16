require('dotenv').config();
const knex = require('knex');

const db = knex({
    client: 'mysql2',
    connection: {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
        port: process.env.DB_PORT
    },
    pool: {
        min: 2,
        max: 5
    }
});

module.exports = db;

db.client.pool.on('acquire', (connection) => {
  console.log(`[DB] Connection acquired (threadId: ${connection.threadId})`);
});

db.client.pool.on('release', (connection) => {
  console.log(`[DB] Connection released (threadId: ${connection.threadId})`);
});