'use strict';

const { Pool } = require('pg');

const config = require('../config');

const pool = new Pool({
  connectionString: config.db.connectionString,
  max: 10,
  idleTimeoutMillis: 30_000
});

// Без этого обработчика разрыв соединения с БД в простое уронил бы процесс.
pool.on('error', (error) => {
  console.error('Ошибка простаивающего соединения с БД:', error.message);
});

function query(text, params) {
  return pool.query(text, params);
}

/**
 * Выполняет набор запросов в одной транзакции.
 * Используется там, где задача и её вложения должны появиться (или исчезнуть) вместе.
 */
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

module.exports = { pool, query, withTransaction };
