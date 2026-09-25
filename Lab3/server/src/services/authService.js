'use strict';

const config = require('../config');
const { withTransaction } = require('../db/pool');
const { HttpError } = require('../lib/httpError');
const { securityEvent } = require('../lib/logger');
const { sendMailInBackground, passwordResetEmail, accountLockedEmail } = require('../lib/mailer');
const { hashPassword, verifyPassword, dummyHash } = require('../lib/password');
const { permissionsOf } = require('../lib/roles');
const tokens = require('../lib/tokens');
const { userRepository } = require('../repositories/userRepository');
const { sessionRepository } = require('../repositories/sessionRepository');
const { loginAttemptRepository } = require('../repositories/loginAttemptRepository');
const { passwordResetRepository } = require('../repositories/passwordResetRepository');

const { auth, bruteForce } = config;

const secondsUntil = (date, plusSec) => (new Date(date).getTime() + plusSec * 1000 - Date.now()) / 1000;

/** Пользователь в ответах API: без хеша пароля, с правами для интерфейса. */
function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    permissions: permissionsOf(user.role)
  };
}

/** Открывает сессию и выдаёт пару временных ключей. */
async function issueSession(user, ctx) {
  const secret = tokens.randomSecret();
  const { session, evicted } = await sessionRepository.create({
    userId: user.id,
    refreshHash: tokens.sha256(secret),
    ip: ctx.ip,
    userAgent: (ctx.userAgent || '').slice(0, 300),
    ttlSec: auth.refreshTokenTtlSec,
    maxSessions: auth.maxSessionsPerUser
  });

  if (evicted.length) {
    securityEvent(ctx.log, 'auth.session.evicted', {
      userId: user.id,
      evicted,
      limit: auth.maxSessionsPerUser
    });
  }

  return {
    sessionId: session.id,
    accessToken: tokens.signAccessToken({ userId: user.id, sessionId: session.id, role: user.role }),
    refreshToken: tokens.composeRefreshToken(session.id, secret),
    expiresIn: auth.accessTokenTtlSec,
    user: publicUser(user)
  };
}

/**
 * Проверки защиты от подбора до сверки пароля:
 *  — с одного IP не больше maxFailuresPerIp неудач за окно (перебор по многим учёткам);
 *  — по одному email не больше maxFailuresPerAccount неудач подряд, затем блокировка
 *    на lockoutSec. Счётчик ведётся по email, даже если такого пользователя нет,
 *    поэтому по поведению блокировки нельзя узнать, зарегистрирован ли адрес.
 */
async function assertNotThrottled(email, ctx) {
  const ip = await loginAttemptRepository.ipFailures(ctx.ip, bruteForce.windowSec);
  if (ip.count >= bruteForce.maxFailuresPerIp) {
    securityEvent(ctx.log, 'auth.login.ip_blocked', { ip: ctx.ip, failures: ip.count }, 'warn');
    throw HttpError.tooManyRequests(
      'Слишком много неудачных попыток входа с вашего адреса. Повторите позже.',
      secondsUntil(ip.firstAt, bruteForce.windowSec),
      'too_many_attempts'
    );
  }

  const account = await loginAttemptRepository.accountFailures(email, bruteForce.windowSec);
  if (account.count >= bruteForce.maxFailuresPerAccount) {
    const retryAfter = secondsUntil(account.lastAt, bruteForce.lockoutSec);
    if (retryAfter > 0) {
      securityEvent(ctx.log, 'auth.login.locked_attempt', { email, ip: ctx.ip }, 'warn');
      throw HttpError.tooManyRequests(
        `Вход временно заблокирован после ${bruteForce.maxFailuresPerAccount} неудачных попыток. ` +
          `Повторите через ${Math.ceil(retryAfter / 60)} мин. или восстановите пароль по email.`,
        retryAfter,
        'account_locked'
      );
    }
  }
  return account.count;
}

async function register({ email, name, password }, ctx) {
  if (await userRepository.findByEmail(email)) {
    throw HttpError.conflict('Пользователь с таким email уже зарегистрирован', {
      code: 'email_taken',
      fields: { email: 'Этот email уже занят' }
    });
  }

  const user = await userRepository.create({ email, name, passwordHash: await hashPassword(password) });
  securityEvent(ctx.log, 'auth.register', { userId: user.id, email, ip: ctx.ip });
  return issueSession(user, ctx);
}

async function login({ email, password }, ctx) {
  const previousFailures = await assertNotThrottled(email, ctx);

  const user = await userRepository.findByEmailWithHash(email);
  const valid = await verifyPassword(password, user ? user.passwordHash : await dummyHash());

  if (!user || !valid) {
    await loginAttemptRepository.record({ email, ip: ctx.ip, success: false, reason: user ? 'bad_password' : 'unknown_email' });
    const failures = previousFailures + 1;
    const left = Math.max(0, bruteForce.maxFailuresPerAccount - failures);
    securityEvent(ctx.log, 'auth.login.failed', { email, ip: ctx.ip, failures, userId: user && user.id }, 'warn');

    if (left === 0) {
      securityEvent(ctx.log, 'auth.account.locked', { email, ip: ctx.ip, lockoutSec: bruteForce.lockoutSec }, 'warn');
      if (user && user.isActive) {
        sendMailInBackground({
          to: user.email,
          ...accountLockedEmail({
            name: user.name,
            ip: ctx.ip,
            lockMinutes: Math.ceil(bruteForce.lockoutSec / 60),
            resetUrl: `${config.appUrl}/forgot-password`
          })
        });
      }
    }

    throw new HttpError(401, left ? `Неверный email или пароль. Осталось попыток: ${left}` : 'Неверный email или пароль. Вход временно заблокирован.', {
      code: 'invalid_credentials'
    });
  }

  // Заблокированному администратором пользователю сообщаем об этом только после
  // верного пароля — иначе ответ выдавал бы статус чужой учётной записи.
  if (!user.isActive) {
    securityEvent(ctx.log, 'auth.login.disabled', { userId: user.id, ip: ctx.ip }, 'warn');
    throw HttpError.forbidden('Учётная запись заблокирована администратором', 'account_disabled');
  }

  await loginAttemptRepository.record({ email, ip: ctx.ip, success: true, reason: 'login' });
  const result = await issueSession(user, ctx);
  securityEvent(ctx.log, 'auth.login.success', { userId: user.id, sessionId: result.sessionId, ip: ctx.ip });
  return result;
}

/**
 * Обмен refresh-токена на новую пару ключей (rotation).
 * Если предъявлен уже использованный токен вне короткого окна гонки —
 * это признак кражи: сессия закрывается целиком.
 */
async function refresh(rawToken, ctx) {
  const invalid = () =>
    HttpError.unauthorized('Сессия истекла или завершена. Войдите снова.', {
      code: 'invalid_refresh_token',
      error: 'invalid_token'
    });

  const parsed = tokens.parseRefreshToken(rawToken);
  if (!parsed) throw invalid();

  const session = await sessionRepository.findForRefresh(parsed.sessionId);
  if (!session || session.revokedAt || new Date(session.expiresAt) <= new Date()) throw invalid();

  const presented = tokens.sha256(parsed.secret);
  let newSecret = tokens.randomSecret();
  const isCurrent = tokens.safeEqualHex(presented, session.refreshHash);
  const rotated =
    isCurrent &&
    (await sessionRepository.rotate(session.id, presented, tokens.sha256(newSecret), auth.refreshTokenTtlSec));

  if (!rotated) {
    // Токен текущий, но ротацию только что выполнил параллельный запрос (гонка) —
    // либо предъявлен предыдущий токен сразу после ротации. Всё остальное — повтор.
    const lostRace = isCurrent;
    const justRotated =
      tokens.safeEqualHex(presented, session.prevRefreshHash) &&
      secondsUntil(session.rotatedAt, auth.refreshReuseGraceSec) > 0;

    if (!lostRace && !justRotated) {
      await sessionRepository.revoke(session.id, 'refresh_reuse');
      securityEvent(ctx.log, 'auth.refresh.reuse_detected', { userId: session.userId, sessionId: session.id, ip: ctx.ip }, 'warn');
      throw invalid();
    }
    // Параллельный запрос уже сменил токен: выдаём только access-токен,
    // cookie с refresh-токеном оставляем тем, что установил победитель гонки.
    newSecret = null;
  }

  const user = await userRepository.findById(session.userId);
  if (!user || !user.isActive) {
    await sessionRepository.revoke(session.id, 'user_disabled');
    throw invalid();
  }

  return {
    sessionId: session.id,
    accessToken: tokens.signAccessToken({ userId: user.id, sessionId: session.id, role: user.role }),
    refreshToken: newSecret ? tokens.composeRefreshToken(session.id, newSecret) : null,
    expiresIn: auth.accessTokenTtlSec,
    user: publicUser(user)
  };
}

/** Выход: закрываем сессию по access-токену или, если он истёк, по refresh-токену. */
async function logout({ sessionId, refreshToken }, ctx) {
  let id = sessionId;
  if (!id) {
    const parsed = tokens.parseRefreshToken(refreshToken);
    const session = parsed && (await sessionRepository.findForRefresh(parsed.sessionId));
    if (session && tokens.safeEqualHex(tokens.sha256(parsed.secret), session.refreshHash)) id = session.id;
  }
  if (id && (await sessionRepository.revoke(id, 'logout'))) {
    securityEvent(ctx.log, 'auth.logout', { sessionId: id, ip: ctx.ip });
  }
}

/**
 * Запрос ссылки восстановления. Ответ всегда одинаковый (202), а письмо уходит
 * в фоне — ни текст, ни время ответа не выдают, есть ли такой пользователь.
 */
async function forgotPassword({ email }, ctx) {
  const user = await userRepository.findByEmail(email);
  if (!user || !user.isActive) {
    securityEvent(ctx.log, 'auth.password_reset.requested_unknown', { email, ip: ctx.ip });
    return;
  }

  const secret = tokens.randomSecret();
  await passwordResetRepository.create(user.id, tokens.sha256(secret), auth.passwordResetTtlSec);

  const link = `${config.appUrl}/reset-password?token=${encodeURIComponent(secret)}`;
  sendMailInBackground({
    to: user.email,
    ...passwordResetEmail({ name: user.name, link, ttlMinutes: Math.round(auth.passwordResetTtlSec / 60) })
  });
  securityEvent(ctx.log, 'auth.password_reset.requested', { userId: user.id, ip: ctx.ip });
}

/**
 * Установка нового пароля по ссылке из письма. Заодно:
 *  — закрываются все сессии (если пароль украли, злоумышленник теряет доступ);
 *  — снимается блокировка входа после неудачных попыток.
 */
async function resetPassword({ token, password }, ctx) {
  const passwordHash = await hashPassword(password);

  const user = await withTransaction(async (client) => {
    const reset = await passwordResetRepository.consume(tokens.sha256(token), client);
    if (!reset) return null;
    await userRepository.setPassword(reset.userId, passwordHash, client);
    const revoked = await sessionRepository.revokeAll(reset.userId, 'password_reset', null, client);
    const { rows } = await client.query('SELECT id, email FROM users WHERE id = $1', [reset.userId]);
    return { ...rows[0], revoked };
  });

  if (!user) {
    throw HttpError.badRequest('Ссылка восстановления недействительна или устарела. Запросите новую.', {
      code: 'invalid_reset_token'
    });
  }

  await loginAttemptRepository.record({ email: user.email, ip: ctx.ip, success: true, reason: 'password_reset' });
  securityEvent(ctx.log, 'auth.password_reset.completed', { userId: user.id, ip: ctx.ip, revokedSessions: user.revoked });
}

async function changePassword(user, sessionId, { currentPassword, newPassword }, ctx) {
  const stored = await userRepository.getPasswordHash(user.id);
  if (!(await verifyPassword(currentPassword, stored))) {
    securityEvent(ctx.log, 'auth.password_change.failed', { userId: user.id, ip: ctx.ip }, 'warn');
    throw HttpError.unprocessable('Текущий пароль указан неверно', { currentPassword: 'Неверный пароль' });
  }

  await userRepository.setPassword(user.id, await hashPassword(newPassword));
  // Текущая сессия остаётся, все остальные устройства придётся авторизовать заново.
  const revoked = await sessionRepository.revokeAll(user.id, 'password_change', sessionId);
  securityEvent(ctx.log, 'auth.password_change.completed', { userId: user.id, revokedSessions: revoked });
}

/** Первый администратор создаётся из переменных окружения при старте API. */
async function ensureAdmin(log) {
  const { email, password, name } = config.seedAdmin;
  const normalized = email.trim().toLowerCase();
  if (await userRepository.findByEmail(normalized)) return;
  await userRepository.create({ email: normalized, name, role: 'admin', passwordHash: await hashPassword(password) });
  securityEvent(log, 'auth.admin.seeded', { email: normalized });
}

module.exports = {
  publicUser,
  register,
  login,
  refresh,
  logout,
  forgotPassword,
  resetPassword,
  changePassword,
  ensureAdmin
};
