'use strict';

const { Pool } = require('pg');

const config = require('../config');
const { logger } = require('../lib/logger');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30_000
});

// Без обработчика разрыв простаивающего соединения уронил бы процесс.
pool.on('error', (error) => logger.error('Ошибка простаивающего соединения с БД', { err: error }));

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
