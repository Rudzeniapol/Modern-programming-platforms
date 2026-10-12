'use strict';

const http = require('http');

const config = require('./config');
const { migrate } = require('./db/migrate');
const { pool } = require('./db/pool');
const { Game } = require('./game/Game');
const { createRequestHandler } = require('./http/app');
const { logger } = require('./lib/logger');
const { Hub } = require('./ws/hub');

/**
 * Собирает и запускает приложение: схема БД → игра из БД → HTTP + WebSocket на одном порту.
 * Возвращает объект для остановки — его используют и точка входа, и автотесты.
 */
async function startServer({ port = config.port } = {}) {
  await migrate();

  const game = new Game();
  await game.init();

  let hub = null;
  const server = http.createServer(createRequestHandler({ game, getOnline: () => hub.onlinePlayers() }));
  hub = new Hub({ server, game });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, resolve);
  });
  const actualPort = server.address().port;
  logger.info(`Сервер слушает http://0.0.0.0:${actualPort}`, { event: 'server.started', port: actualPort });

  return {
    server,
    game,
    hub,
    port: actualPort,
    async stop() {
      hub.close();
      game.stop();
      // Ходы, которые уже в очереди, должны успеть записаться в БД.
      await game.queue.run(() => undefined);
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeIdleConnections();
      });
    }
  };
}

if (require.main === module) {
  startServer()
    .then((app) => {
      const shutdown = async (signal) => {
        logger.info('Останавливаю сервер…', { signal });
        await app.stop();
        await pool.end();
        process.exit(0);
      };
      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    })
    .catch((error) => {
      logger.error('Не удалось запустить сервер', { err: error });
      process.exit(1);
    });

  process.on('unhandledRejection', (reason) => logger.error('Необработанный отказ промиса', { err: reason }));
}

module.exports = { startServer };
