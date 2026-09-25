'use strict';

const { query } = require('../db/pool');

const loginAttemptRepository = {
  async record({ email, ip, success, reason }) {
    await query('INSERT INTO login_attempts (email, ip, success, reason) VALUES ($1, $2, $3, $4)', [
      email,
      ip,
      success,
      reason
    ]);
  },

  /**
   * Неудачные попытки по email за окно windowSec после последнего успеха
   * (успешный вход или сброс пароля обнуляет счётчик).
   */
  async accountFailures(email, windowSec) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count, MAX(created_at) AS "lastAt"
         FROM login_attempts
        WHERE email = $1
          AND NOT success
          AND created_at > now() - make_interval(secs => $2)
          AND created_at > COALESCE((SELECT MAX(created_at) FROM login_attempts
                                      WHERE email = $1 AND success), '-infinity')`,
      [email, windowSec]
    );
    return rows[0];
  },

  /** Неудачные попытки с одного IP по любым email — защита от перебора по многим учёткам. */
  async ipFailures(ip, windowSec) {
    const { rows } = await query(
      `SELECT COUNT(*)::int AS count, MIN(created_at) AS "firstAt"
         FROM login_attempts
        WHERE ip = $1 AND NOT success AND created_at > now() - make_interval(secs => $2)`,
      [ip, windowSec]
    );
    return rows[0];
  },

  async purgeOlderThan(days = 30) {
    await query('DELETE FROM login_attempts WHERE created_at < now() - make_interval(days => $1)', [days]);
  }
};

module.exports = { loginAttemptRepository };
