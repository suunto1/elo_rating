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
    timezone: 'Z', // ✅ исправлено
    connectTimeout: 10000,
    decimalNumbers: true,
    supportBigNumbers: true,
    bigNumberStrings: true
  },
  pool: {
    min: 2,
    max: 10, // ✅ увеличено
    acquireTimeoutMillis: 30000,
    idleTimeoutMillis: 30000,
    reapIntervalMillis: 1000,
    createRetryIntervalMillis: 200,
    createTimeoutMillis: 30000,
    propagateCreateError: false
  },
  debug: process.env.NODE_ENV === 'development',
  asyncStackTraces: true
});

// Health-check
setInterval(async () => {
  try {
    await db.raw('SELECT 1');
  } catch (err) {
    console.error('DB Health-Check Failed:', err.message);
  }
}, 300000);

// Optional: debug pool usage
setInterval(() => {
  const pool = db.client.pool;
  console.log(`Pool usage: used=${pool.numUsed()}, free=${pool.numFree()}, pending=${pool.numPendingAcquires()}`);
}, 60000);

process.on('SIGTERM', async () => {
  await db.destroy();
});

module.exports = db;
