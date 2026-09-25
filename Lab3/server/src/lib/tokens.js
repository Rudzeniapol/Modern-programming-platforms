'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { auth } = require('../config');

const ALGORITHM = 'HS256';

/**
 * Access-токен — временный ключ доступа (JWT, по умолчанию живёт 15 минут).
 * sub — пользователь, sid — сессия, role — роль на момент выдачи.
 * Сервер всё равно сверяет сессию с БД на каждом запросе: так отзыв сессии
 * или смена роли действуют сразу, не дожидаясь истечения токена.
 */
function signAccessToken({ userId, sessionId, role }) {
  return jwt.sign({ role, sid: sessionId }, auth.jwtSecret, {
    algorithm: ALGORITHM,
    subject: userId,
    issuer: auth.jwtIssuer,
    audience: auth.jwtAudience,
    expiresIn: auth.accessTokenTtlSec,
    jwtid: crypto.randomUUID()
  });
}

/** Бросает jwt.TokenExpiredError / JsonWebTokenError — их разбирает middleware. */
function verifyAccessToken(token) {
  return jwt.verify(token, auth.jwtSecret, {
    algorithms: [ALGORITHM],
    issuer: auth.jwtIssuer,
    audience: auth.jwtAudience
  });
}

/** Случайный секрет для refresh-токена и ссылки восстановления пароля. */
function randomSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// В БД хранится только SHA-256 от секрета: утечка таблицы не даёт готовых токенов.
function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a), 'hex');
  const right = Buffer.from(String(b), 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

/** Refresh-токен: «<id сессии>.<секрет>» — по id сессия ищется, секрет сверяется с хешем. */
function composeRefreshToken(sessionId, secret) {
  return `${sessionId}.${secret}`;
}

function parseRefreshToken(token) {
  if (typeof token !== 'string') return null;
  const match = /^([0-9a-f-]{36})\.([\w-]{20,})$/i.exec(token);
  return match ? { sessionId: match[1], secret: match[2] } : null;
}

module.exports = {
  signAccessToken,
  verifyAccessToken,
  randomSecret,
  sha256,
  safeEqualHex,
  composeRefreshToken,
  parseRefreshToken
};
