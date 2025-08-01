require('dotenv').config();
const knex = require('knex');
const { setIntervalAsync } = require('set-interval-async');
const { clearIntervalAsync } = require('set-interval-async/dynamic');

// Конфигурация с улучшенным управлением соединениями
const config = {
  client: 'mysql2',
  connection: {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    port: process.env.DB_PORT || 3306,
    timezone: 'UTC',
    connectTimeout: 10000, // 10 секунд на подключение
    decimalNumbers: true, // Для корректной работы с DECIMAL
    supportBigNumbers: true,
    bigNumberStrings: true
  },
  pool: {
    min: 1, // Минимум 1 соединение (для бесплатного Aiven)
    max: 5, // Не больше 5 соединений (лимит free-плана)
    acquireTimeoutMillis: 30000,
    idleTimeoutMillis: 30000, // Увеличил время жизни соединения
    reapIntervalMillis: 1000,
    createRetryIntervalMillis: 200,
    createTimeoutMillis: 30000,
    propagateCreateError: false // Подавляем ошибки при создании
  },
  debug: process.env.NODE_ENV === 'development', // Логи только в dev
  asyncStackTraces: true
};

const db = knex(config);

// 🔄 Health-check соединений каждые 5 минут
const healthCheckInterval = setIntervalAsync(async () => {
  try {
    await db.raw('SELECT 1');
  } catch (err) {
    console.error('🔄 DB Health-Check Failed:', err.message);
    // Автоматическое восстановление
    await db.destroy();
    db.initialize(config);
  }
}, 300000); // 5 минут

// 🛑 Graceful shutdown
process.on('SIGTERM', async () => {
  await clearIntervalAsync(healthCheckInterval);
  await db.destroy();
});

// 💡 Логирование событий пула
db.on('pool.created', () => console.log('🔄 New DB connection created'));
db.on('pool.destroyed', (client) => console.log('♻️ Connection destroyed'));
db.on('pool.acquire', () => console.log('🔑 Connection acquired'));
db.on('pool.release', () => console.log('🔓 Connection released'));

module.exports = db;