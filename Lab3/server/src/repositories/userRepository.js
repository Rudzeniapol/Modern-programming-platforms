'use strict';

const { query } = require('../db/pool');

// password_hash наружу не отдаётся никогда — только в findByEmailWithHash для входа.
const USER_SELECT = `
  u.id,
  u.email,
  u.name,
  u.role,
  u.is_active  AS "isActive",
  u.created_at AS "createdAt",
  u.updated_at AS "updatedAt"
`;

const userRepository = {
  async create({ email, name, passwordHash, role = 'user' }, client = { query }) {
    const { rows } = await client.query(
      `INSERT INTO users (email, name, password_hash, role)
       VALUES ($1, $2, $3, $4)
       RETURNING ${USER_SELECT.replace(/u\./g, '')}`,
      [email, name, passwordHash, role]
    );
    return rows[0];
  },

  async findById(id) {
    const { rows } = await query(`SELECT ${USER_SELECT} FROM users u WHERE u.id = $1`, [id]);
    return rows[0] || null;
  },

  async findByEmail(email) {
    const { rows } = await query(`SELECT ${USER_SELECT} FROM users u WHERE u.email = $1`, [email]);
    return rows[0] || null;
  },

  async findByEmailWithHash(email) {
    const { rows } = await query(
      `SELECT ${USER_SELECT}, u.password_hash AS "passwordHash" FROM users u WHERE u.email = $1`,
      [email]
    );
    return rows[0] || null;
  },

  async getPasswordHash(id) {
    const { rows } = await query('SELECT password_hash AS "passwordHash" FROM users WHERE id = $1', [id]);
    return rows[0] ? rows[0].passwordHash : null;
  },

  /**
   * Список пользователей для администратора: сколько у каждого активных сессий
   * и заблокирован ли вход после серии неудачных попыток.
   */
  async list({ windowSec, maxFailures, lockoutSec }) {
    const { rows } = await query(
      `SELECT ${USER_SELECT},
              (SELECT COUNT(*)::int FROM sessions s
                WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS "activeSessions",
              lock.locked_until AS "lockedUntil"
         FROM users u
         LEFT JOIN LATERAL (
           SELECT CASE WHEN COUNT(*) >= $2 AND MAX(a.created_at) + make_interval(secs => $3) > now()
                       THEN MAX(a.created_at) + make_interval(secs => $3) END AS locked_until
             FROM login_attempts a
            WHERE a.email = u.email
              AND NOT a.success
              AND a.created_at > now() - make_interval(secs => $1)
              AND a.created_at > COALESCE((SELECT MAX(created_at) FROM login_attempts
                                            WHERE email = u.email AND success), '-infinity')
         ) lock ON true
        ORDER BY u.created_at`,
      [windowSec, maxFailures, lockoutSec]
    );
    return rows;
  },

  async update(id, { role, isActive }) {
    const { rows } = await query(
      `UPDATE users
          SET role       = COALESCE($2, role),
              is_active  = COALESCE($3, is_active),
              updated_at = now()
        WHERE id = $1
        RETURNING ${USER_SELECT.replace(/u\./g, '')}`,
      [id, role ?? null, isActive ?? null]
    );
    return rows[0] || null;
  },

  async setPassword(id, passwordHash, client = { query }) {
    await client.query(
      `UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now() WHERE id = $1`,
      [id, passwordHash]
    );
  },

  async countAdmins() {
    const { rows } = await query(`SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND is_active`);
    return rows[0].count;
  }
};

module.exports = { userRepository };
