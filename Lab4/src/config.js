'use strict';

const path = require('path');

const env = process.env.NODE_ENV || 'development';

const number = (value, fallback) => {
  const parsed = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Все настройки игры и сервера в одном месте. Значения по умолчанию подходят
 * для локального запуска; в Docker и на хостинге их переопределяют переменные окружения.
 */
module.exports = {
  env,
  isTest: env === 'test',
  // Хостинги (Render, Railway, Fly.io) сами сообщают порт через PORT.
  port: number(process.env.PORT, 8092),
  publicDir: path.resolve(__dirname, '..', 'public'),
  databaseUrl: process.env.DATABASE_URL || 'postgres://pixels:pixels@localhost:5432/pixels',
  // Облачные Postgres (Neon, Render) требуют TLS-соединение.
  databaseSsl: process.env.DATABASE_SSL === 'true',

  log: {
    level: process.env.LOG_LEVEL || (env === 'test' ? 'silent' : 'info')
  },

  board: {
    width: number(process.env.BOARD_WIDTH, 64),
    height: number(process.env.BOARD_HEIGHT, 40)
  },

  // Команды: индекс в массиве — то, что хранится в БД (cells.team, players.team).
  teams: [
    { id: 0, name: 'Красные', color: '#e5484d' },
    { id: 1, name: 'Синие', color: '#3e63dd' },
    { id: 2, name: 'Зелёные', color: '#30a46c' },
    { id: 3, name: 'Жёлтые', color: '#f0b400' }
  ],

  // «Заряды»: сколько клеток игрок может закрасить подряд и как быстро они восстанавливаются.
  charges: {
    max: number(process.env.CHARGES_MAX, 10),
    regenMs: number(process.env.CHARGE_REGEN_MS, 3000)
  },

  round: {
    durationSec: number(process.env.ROUND_DURATION_SEC, 10 * 60),
    // Сколько последних раундов хранить целиком (поле + журнал ходов).
    keepRounds: number(process.env.KEEP_ROUNDS, 10)
  },

  ws: {
    path: '/ws',
    // Сервер пингует клиентов: кто не ответил за интервал — «мёртвое» соединение.
    heartbeatMs: number(process.env.WS_HEARTBEAT_MS, 15000),
    maxPayload: 16 * 1024,
    // Ограничение частоты сообщений от одного соединения (token bucket).
    rate: { perSec: 25, burst: 50 },
    cursorMinIntervalMs: 50
  },

  sync: {
    // Если клиент отстал больше чем на столько изменений, вместо дельты шлём снимок поля.
    maxDelta: 2000
  }
};
