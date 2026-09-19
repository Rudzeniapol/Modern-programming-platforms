'use strict';

const app = require('./app');
const config = require('./config');
const { migrate } = require('./db/migrate');
const { pool } = require('./db/pool');

async function start() {
  await migrate();

  const server = app.listen(config.port, () => {
    console.log(`REST API слушает http://0.0.0.0:${config.port}/api`);
  });

  // Docker останавливает контейнер сигналом SIGTERM: закрываем сервер и пул
  // соединений, чтобы не оставлять оборванных транзакций.
  const shutdown = (signal) => {
    console.log(`Получен ${signal}, останавливаю сервер…`);
    server.close(() => {
      pool.end().finally(() => process.exit(0));
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  console.error('Не удалось запустить сервер:', error);
  process.exit(1);
});
