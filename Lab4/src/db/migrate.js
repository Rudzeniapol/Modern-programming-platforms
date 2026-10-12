'use strict';

const fs = require('fs/promises');
const path = require('path');

const { pool } = require('./pool');
const { logger } = require('../lib/logger');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** В docker-compose приложение стартует раньше, чем Postgres готов принимать соединения. */
async function waitForDatabase(retries = 30, delayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const client = await pool.connect();
      client.release();
      return;
    } catch (error) {
      if (attempt === retries) {
        throw new Error(`База данных недоступна после ${retries} попыток: ${error.message}`, {
          cause: error
        });
      }
      logger.info('Жду базу данных…', { attempt, of: retries });
      await delay(delayMs);
    }
  }
}

async function migrate() {
  await waitForDatabase();
  const sql = await fs.readFile(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  logger.info('Схема БД готова');
}

module.exports = { migrate };
