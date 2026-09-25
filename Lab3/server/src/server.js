'use strict';

const app = require('./app');
const config = require('./config');
const { migrate } = require('./db/migrate');
const { pool } = require('./db/pool');
const { logger } = require('./lib/logger');
const { ensureAdmin } = require('./services/authService');
const { sessionRepository } = require('./repositories/sessionRepository');
const { loginAttemptRepository } = require('./repositories/loginAttemptRepository');

const HOUR_MS = 60 * 60 * 1000;

// Старые записи о попытках входа и закрытые сессии больше не нужны.
async function purgeStaleRecords() {
  try {
    await Promise.all([sessionRepository.purgeExpired(), loginAttemptRepository.purgeOlderThan()]);
  } catch (error) {
    logger.warn({ err: error }, 'Не удалось очистить устаревшие записи');
  }
}

async function start() {
  if (config.auth.usesDevSecret) {
    logger.warn('JWT_SECRET не задан — используется небезопасный ключ для разработки');
  }

  await migrate();
  await ensureAdmin(logger);
  await purgeStaleRecords();
  setInterval(purgeStaleRecords, HOUR_MS).unref();

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, `REST API слушает http://0.0.0.0:${config.port}/api`);
  });

  // Docker останавливает контейнер сигналом SIGTERM: закрываем сервер и пул
  // соединений, чтобы не оставлять оборванных транзакций.
  const shutdown = (signal) => {
    logger.info({ signal }, 'Останавливаю сервер…');
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Необработанный отказ промиса');
});

start().catch((error) => {
  logger.fatal({ err: error }, 'Не удалось запустить сервер');
  process.exit(1);
});
