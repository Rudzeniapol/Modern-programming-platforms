'use strict';

const { query, withTransaction } = require('../db/pool');

const SESSION_SELECT = `
  s.id,
  s.user_id      AS "userId",
  s.ip,
  s.user_agent   AS "userAgent",
  s.created_at   AS "createdAt",
  s.last_seen_at AS "lastSeenAt",
  s.expires_at   AS "expiresAt"
`;

const ACTIVE = 's.revoked_at IS NULL AND s.expires_at > now()';

const sessionRepository = {
  /**
   * Открывает сессию и следит за лимитом одновременных подключений:
   * если активных сессий больше maxSessions, самые старые закрываются.
   * Возвращает сессию и список вытесненных id (для журнала).
   */
  async create({ userId, refreshHash, ip, userAgent, ttlSec, maxSessions }) {
    return withTransaction(async (client) => {
      // Блокировка строки пользователя сериализует параллельные входы одного
      // пользователя — иначе лимит сессий можно было бы обойти гонкой.
      await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);

      const { rows } = await client.query(
        `INSERT INTO sessions (user_id, refresh_hash, ip, user_agent, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
         RETURNING id, user_id AS "userId", created_at AS "createdAt", expires_at AS "expiresAt"`,
        [userId, refreshHash, ip, userAgent, ttlSec]
      );

      const { rows: evicted } = await client.query(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'session_limit'
          WHERE id IN (
            SELECT s.id FROM sessions s
             WHERE s.user_id = $1 AND ${ACTIVE}
             ORDER BY s.last_seen_at DESC, s.created_at DESC
             OFFSET $2
          )
          RETURNING id`,
        [userId, maxSessions]
      );

      return { session: rows[0], evicted: evicted.map((row) => row.id) };
    });
  },

  /** Сессия вместе с пользователем — то, что нужно middleware аутентификации. */
  async findActiveWithUser(sessionId) {
    const { rows } = await query(
      `SELECT s.id AS "sessionId", s.last_seen_at AS "lastSeenAt",
              u.id, u.email, u.name, u.role, u.is_active AS "isActive"
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND ${ACTIVE}`,
      [sessionId]
    );
    return rows[0] || null;
  },

  async findForRefresh(sessionId) {
    const { rows } = await query(
      `SELECT s.id, s.user_id AS "userId", s.refresh_hash AS "refreshHash",
              s.prev_refresh_hash AS "prevRefreshHash", s.rotated_at AS "rotatedAt",
              s.revoked_at AS "revokedAt", s.expires_at AS "expiresAt"
         FROM sessions s WHERE s.id = $1`,
      [sessionId]
    );
    return rows[0] || null;
  },

  /**
   * Ротация refresh-токена. Условие по старому хешу делает операцию атомарной:
   * из двух одновременных запросов с одним токеном выиграет ровно один.
   */
  async rotate(sessionId, expectedHash, newHash, ttlSec) {
    const { rowCount } = await query(
      `UPDATE sessions
          SET prev_refresh_hash = refresh_hash,
              refresh_hash      = $3,
              rotated_at        = now(),
              last_seen_at      = now(),
              expires_at        = now() + make_interval(secs => $4)
        WHERE id = $1 AND refresh_hash = $2 AND revoked_at IS NULL`,
      [sessionId, expectedHash, newHash, ttlSec]
    );
    return rowCount > 0;
  },

  async touch(sessionId) {
    await query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [sessionId]);
  },

  async listActive(userId) {
    const { rows } = await query(
      `SELECT ${SESSION_SELECT} FROM sessions s
        WHERE s.user_id = $1 AND ${ACTIVE}
        ORDER BY s.last_seen_at DESC`,
      [userId]
    );
    return rows;
  },

  async revoke(sessionId, reason, userId = null) {
    const { rowCount } = await query(
      `UPDATE sessions s SET revoked_at = now(), revoke_reason = $2
        WHERE s.id = $1 AND ${ACTIVE} AND ($3::uuid IS NULL OR s.user_id = $3::uuid)`,
      [sessionId, reason, userId]
    );
    return rowCount > 0;
  },

  /** Закрывает все сессии пользователя, кроме exceptId (если задан). Возвращает число закрытых. */
  async revokeAll(userId, reason, exceptId = null, client = { query }) {
    const { rowCount } = await client.query(
      `UPDATE sessions s SET revoked_at = now(), revoke_reason = $2
        WHERE s.user_id = $1 AND ${ACTIVE} AND ($3::uuid IS NULL OR s.id <> $3::uuid)`,
      [userId, reason, exceptId]
    );
    return rowCount;
  },

  async purgeExpired(olderThanDays = 30) {
    await query(
      `DELETE FROM sessions
        WHERE COALESCE(revoked_at, expires_at) < now() - make_interval(days => $1)`,
      [olderThanDays]
    );
  }
};

module.exports = { sessionRepository };
