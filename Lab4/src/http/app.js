'use strict';

const config = require('../config');
const { pool } = require('../db/pool');
const { logger } = require('../lib/logger');
const { createStaticHandler } = require('./static');

// Строгая политика безопасности контента: скрипты, стили и соединения — только
// с собственного origin (WebSocket — тоже с него, по ws:// или wss://).
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * Обработчик HTTP-запросов на «голом» модуле http — без Express.
 *   GET /api/health — проба живости для docker и хостинга;
 *   GET /api/state  — краткая сводка: раунд, счёт, онлайн (удобно для проверки);
 *   всё остальное   — статические файлы клиента.
 */
function createRequestHandler({ game, getOnline }) {
  const serveStatic = createStaticHandler(config.publicDir);

  return async function handleRequest(req, res) {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      if (req.url === '/api/health') return;
      logger.info(`${req.method} ${req.url} → ${res.statusCode}`, {
        event: 'http.request',
        method: req.method,
        url: req.url,
        status: res.statusCode,
        ms: Number(process.hrtime.bigint() - started) / 1e6
      });
    });

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return sendJson(res, 405, { error: 'Метод не поддерживается' });
    }

    const { pathname } = new URL(req.url, 'http://localhost');

    try {
      if (pathname === '/api/health') {
        await pool.query('SELECT 1');
        return sendJson(res, 200, { status: 'ok', database: 'up' });
      }
      if (pathname === '/api/state') {
        return sendJson(res, 200, {
          round: game.publicRound(),
          scores: game.scores(),
          online: getOnline(),
          seq: game.seq
        });
      }
      if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'Ресурс не найден' });
    } catch (error) {
      logger.error('Ошибка HTTP-запроса', { url: req.url, err: error });
      res.setHeader('Retry-After', '5');
      return sendJson(res, 503, { status: 'degraded', database: 'down' });
    }

    return serveStatic(req, res, pathname);
  };
}

module.exports = { createRequestHandler };
