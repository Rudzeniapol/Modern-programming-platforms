'use strict';

const jwt = require('jsonwebtoken');

const { HttpError } = require('../lib/httpError');
const { hasPermission } = require('../lib/roles');
const { verifyAccessToken } = require('../lib/tokens');
const { sessionRepository } = require('../repositories/sessionRepository');

// last_seen_at обновляем не чаще раза в минуту — не пишем в БД на каждый запрос.
const TOUCH_INTERVAL_MS = 60 * 1000;

function bearerToken(req) {
  const header = req.headers.authorization;
  if (!header) return null;
  const match = /^Bearer\s+([\w-]+\.[\w-]+\.[\w-]+)$/i.exec(header);
  if (!match) {
    throw HttpError.unauthorized('Заголовок Authorization должен иметь вид «Bearer <token>»', {
      code: 'invalid_token',
      error: 'invalid_request'
    });
  }
  return match[1];
}

/**
 * Проверяет временный ключ (access-токен) и сессию, к которой он привязан.
 * Результат — req.user (актуальные данные и роль из БД) и req.sessionId.
 */
async function resolveUser(req, token) {
  let payload;
  try {
    payload = verifyAccessToken(token);
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw HttpError.unauthorized('Срок действия ключа доступа истёк', { code: 'token_expired', error: 'invalid_token' });
    }
    throw HttpError.unauthorized('Ключ доступа недействителен', { code: 'invalid_token', error: 'invalid_token' });
  }

  // row.id — пользователь, row.sessionId — сессия.
  const row = await sessionRepository.findActiveWithUser(payload.sid);
  if (!row || row.id !== payload.sub || !row.isActive) {
    throw HttpError.unauthorized('Сессия завершена. Войдите снова.', { code: 'session_revoked', error: 'invalid_token' });
  }

  req.user = { id: row.id, email: row.email, name: row.name, role: row.role };
  req.sessionId = row.sessionId;
  req.log = req.log.child({ userId: row.id, sessionId: row.sessionId });

  if (Date.now() - new Date(row.lastSeenAt).getTime() > TOUCH_INTERVAL_MS) {
    sessionRepository.touch(row.sessionId).catch((error) => req.log.warn({ err: error }, 'Не удалось обновить last_seen_at'));
  }
}

/** Маршрут доступен только аутентифицированным пользователям (иначе 401). */
async function authenticate(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) throw HttpError.unauthorized();
    await resolveUser(req, token);
    next();
  } catch (error) {
    next(error);
  }
}

/** Аутентификация по возможности: без заголовка запрос проходит анонимно. */
async function optionalAuthenticate(req, res, next) {
  try {
    const token = bearerToken(req);
    if (token) await resolveUser(req, token);
    next();
  } catch {
    next();
  }
}

/** Проверка права по ролевой модели: пользователь известен, но прав нет — 403. */
function requirePermission(permission) {
  return function permissionGuard(req, res, next) {
    if (!req.user) return next(HttpError.unauthorized());
    if (!hasPermission(req.user, permission)) {
      req.log.warn({ event: 'access.denied', permission, role: req.user.role }, 'Доступ запрещён');
      return next(HttpError.forbidden());
    }
    return next();
  };
}

module.exports = { authenticate, optionalAuthenticate, requirePermission };
