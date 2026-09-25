'use strict';

const pino = require('pino');

const config = require('../config');

/**
 * Структурированный журнал: каждая запись — одна JSON-строка в stdout
 * (её собирает docker logs / любой агрегатор логов).
 *
 * Поля, которые есть в каждой записи: level, time (ISO 8601), service, env, msg.
 * Записи, связанные с запросом, дополнительно несут reqId и userId,
 * события безопасности — поле event (например, auth.login.failed).
 */
const logger = pino({
  level: config.log.level,
  base: { service: 'spp-lab3-api', env: config.env },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    // Уровень строкой ("warn"), а не числом (40) — так журнал читается без таблицы кодов.
    level: (label) => ({ level: label })
  },
  // Секреты не должны попадать в журнал ни при каких обстоятельствах.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.currentPassword',
      '*.newPassword',
      '*.token',
      '*.accessToken',
      '*.refreshToken'
    ],
    censor: '[REDACTED]'
  }
});

/**
 * Событие безопасности: вход, блокировка, сброс пароля, отзыв сессий и т. п.
 * Имя события — машиночитаемое, по нему удобно строить выборки и алерты.
 */
function securityEvent(log, event, details = {}, level = 'info') {
  (log || logger)[level]({ event, ...details }, event);
}

module.exports = { logger, securityEvent };
