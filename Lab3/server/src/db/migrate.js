'use strict';

const fs = require('fs/promises');
const path = require('path');

const config = require('../config');
const { pool } = require('./pool');
const { logger } = require('../lib/logger');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Дожидается готовности Postgres: в docker-compose контейнер API стартует
 * раньше, чем база начинает принимать соединения.
 */
async function waitForDatabase() {
  const { connectRetries, connectRetryDelayMs } = config.db;

  for (let attempt = 1; attempt <= connectRetries; attempt += 1) {
    try {
      const client = await pool.connect();
      client.release();
      return;
    } catch (error) {
      if (attempt === connectRetries) {
        throw new Error(`База данных недоступна после ${connectRetries} попыток: ${error.message}`, {
          cause: error
        });
      }
      logger.info({ attempt, of: connectRetries }, 'Жду базу данных…');
      await delay(connectRetryDelayMs);
    }
  }
}

async function migrate() {
  await waitForDatabase();
  const sql = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  logger.info('Схема БД готова');
}

module.exports = { migrate, waitForDatabase };
