'use strict';

const { query } = require('../db/pool');

const passwordResetRepository = {
  /** Новый токен делает недействительными все прежние: рабочей остаётся только последняя ссылка. */
  async create(userId, tokenHash, ttlSec) {
    await query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [userId]);
    await query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3))`,
      [userId, tokenHash, ttlSec]
    );
  },

  /**
   * Атомарно «гасит» токен: повторно одной ссылкой воспользоваться нельзя,
   * даже если два запроса придут одновременно.
   */
  async consume(tokenHash, client = { query }) {
    const { rows } = await client.query(
      `UPDATE password_resets SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING user_id AS "userId"`,
      [tokenHash]
    );
    return rows[0] || null;
  }
};

module.exports = { passwordResetRepository };
