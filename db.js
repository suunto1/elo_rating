const mysql = require("mysql2/promise");

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 60,
    queueLimit: 1000
});

module.exports = pool;

pool.on('acquire', () => {
    console.log('[DB] Connection acquired');
});
pool.on('release', () => {
    console.log('[DB] Connection released');
});
pool.on('enqueue', () => {
    console.log('[DB] Waiting for available connection slot');
});
