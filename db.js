require('dotenv').config();
const knex = require('knex');

const db = knex({
    client: 'mysql2',
    connection: {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_DATABASE,
        port: process.env.DB_PORT || 3306,
        connectTimeout: 20000, // ⏱️ 10 сек таймаут подключения
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000
    },
    pool: {
        min: 2,
        max: 10,
        acquireTimeoutMillis: 30000, // ⏱️ ожидание свободного соединения
        idleTimeoutMillis: 5000,     // ⏱️ сколько держать неиспользуемое соединение
    }
});

module.exports = db;
