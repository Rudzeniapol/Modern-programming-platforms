'use strict';

const config = require('../config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const threshold = LEVELS[config.log.level] ?? LEVELS.info;

function serializeError(error) {
  if (!(error instanceof Error)) return error;
  return { name: error.name, message: error.message, code: error.code, stack: error.stack };
}

/**
 * Структурированный журнал: одна JSON-строка на запись в stdout.
 * Каждая запись: level, time, service, msg + произвольные поля (event, playerId, …).
 */
function write(level, msg, fields = {}) {
  if (LEVELS[level] < threshold) return;
  const entry = { level, time: new Date().toISOString(), service: 'spp-lab4', msg, ...fields };
  if (entry.err) entry.err = serializeError(entry.err);
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

const logger = {
  debug: (msg, fields) => write('debug', msg, fields),
  info: (msg, fields) => write('info', msg, fields),
  warn: (msg, fields) => write('warn', msg, fields),
  error: (msg, fields) => write('error', msg, fields)
};

module.exports = { logger };
