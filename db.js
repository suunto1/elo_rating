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
        connectTimeout: 20000 // ⏱️ 10 сек таймаут подключения
    },
    pool: {
        min: 2,
        max: 20,
        acquireTimeoutMillis: 30000, // ⏱️ ожидание свободного соединения
        idleTimeoutMillis: 10000     // ⏱️ сколько держать неиспользуемое соединение
    }
});

// Логирование соединений — полезно для отладки
db.client.pool.on('acquire', (connection) => {
    console.log(`[DB] Connection acquired (threadId: ${connection.threadId})`);
});

db.client.pool.on('release', (connection) => {
    console.log(`[DB] Connection released (threadId: ${connection.threadId})`);
});

// Обработка ошибок пула (особенно важна!)
db.client.pool.on('error', (err) => {
    console.error('[DB] Pool error:', err);
});

module.exports = db;
