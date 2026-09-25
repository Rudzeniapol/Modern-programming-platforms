'use strict';

const express = require('express');

const config = require('../config');
const authService = require('../services/authService');
const { sessionRepository } = require('../repositories/sessionRepository');
const { authenticate, optionalAuthenticate } = require('../middleware/auth');
const { requireJson } = require('../middleware/contentType');
const { methodNotAllowed } = require('../middleware/errors');
const { rateLimit } = require('../middleware/rateLimit');
const { asyncHandler } = require('../lib/asyncHandler');
const { HttpError } = require('../lib/httpError');
const { securityEvent } = require('../lib/logger');
const { assertUuid } = require('../lib/validation');
const v = require('../lib/authValidation');

const router = express.Router();
const { auth } = config;

// Общий лимит на публичные auth-эндпоинты и отдельный, более строгий, —
// на отправку писем (иначе через форму «забыли пароль» можно заспамить ящик).
const authLimiter = rateLimit({ name: 'auth', ...config.rateLimit.auth });
const resetLimiter = rateLimit({
  name: 'password-reset',
  ...config.rateLimit.passwordReset,
  message: 'Слишком много запросов на восстановление пароля. Повторите позже.'
});

const context = (req) => ({ ip: req.ip, userAgent: req.get('user-agent'), log: req.log });

/**
 * Refresh-токен живёт в cookie с флагами HttpOnly (недоступен JavaScript, а значит
 * и XSS), SameSite=Strict (не уходит с чужих сайтов) и Path=/api/auth
 * (не отправляется с остальными запросами).
 */
const cookieOptions = () => ({
  httpOnly: true,
  secure: auth.cookieSecure,
  sameSite: 'strict',
  path: '/api/auth'
});

function sendTokens(res, status, result) {
  if (result.refreshToken) {
    res.cookie(auth.refreshCookieName, result.refreshToken, {
      ...cookieOptions(),
      maxAge: auth.refreshTokenTtlSec * 1000
    });
  }
  // Ключи доступа не должны оседать в кешах прокси и браузера.
  res.set('Cache-Control', 'no-store');
  res.status(status).json({
    accessToken: result.accessToken,
    tokenType: 'Bearer',
    expiresIn: result.expiresIn,
    user: result.user
  });
}

const refreshTokenFrom = (req) =>
  (req.cookies && req.cookies[auth.refreshCookieName]) || (req.body && req.body.refreshToken);

// POST /api/auth/register — регистрация. Новый пользователь всегда получает роль user.
router
  .route('/register')
  .post(
    authLimiter,
    requireJson,
    asyncHandler(async (req, res) => {
      const result = await authService.register(v.validateRegistration(req.body), context(req));
      res.location('/api/auth/me');
      sendTokens(res, 201, result);
    })
  )
  .all(methodNotAllowed('POST'));

// POST /api/auth/login — вход по email и паролю.
router
  .route('/login')
  .post(
    authLimiter,
    requireJson,
    asyncHandler(async (req, res) => {
      sendTokens(res, 200, await authService.login(v.validateLogin(req.body), context(req)));
    })
  )
  .all(methodNotAllowed('POST'));

// POST /api/auth/refresh — новая пара ключей в обмен на refresh-токен из cookie.
router
  .route('/refresh')
  .post(
    authLimiter,
    asyncHandler(async (req, res) => {
      try {
        sendTokens(res, 200, await authService.refresh(refreshTokenFrom(req), context(req)));
      } catch (error) {
        if (error instanceof HttpError && error.status === 401) {
          res.clearCookie(auth.refreshCookieName, cookieOptions());
        }
        throw error;
      }
    })
  )
  .all(methodNotAllowed('POST'));

// POST /api/auth/logout — завершение текущей сессии. Идемпотентен: всегда 204.
router
  .route('/logout')
  .post(
    optionalAuthenticate,
    asyncHandler(async (req, res) => {
      await authService.logout({ sessionId: req.sessionId, refreshToken: refreshTokenFrom(req) }, context(req));
      res.clearCookie(auth.refreshCookieName, cookieOptions());
      res.status(204).end();
    })
  )
  .all(methodNotAllowed('POST'));

// POST /api/auth/password/forgot — письмо со ссылкой восстановления.
// 202 Accepted: запрос принят, результат (письмо) будет позже и не раскрывается.
router
  .route('/password/forgot')
  .post(
    resetLimiter,
    requireJson,
    asyncHandler(async (req, res) => {
      await authService.forgotPassword(v.validateForgotPassword(req.body), context(req));
      res.status(202).json({
        message: 'Если такой email зарегистрирован, на него отправлено письмо со ссылкой для восстановления доступа.'
      });
    })
  )
  .all(methodNotAllowed('POST'));

// POST /api/auth/password/reset — новый пароль по токену из письма.
router
  .route('/password/reset')
  .post(
    authLimiter,
    requireJson,
    asyncHandler(async (req, res) => {
      await authService.resetPassword(v.validateResetPassword(req.body), context(req));
      res.clearCookie(auth.refreshCookieName, cookieOptions());
      res.status(204).end();
    })
  )
  .all(methodNotAllowed('POST'));

// Всё ниже — только для вошедших пользователей.

// GET /api/auth/me — текущий пользователь, его роль и права.
router
  .route('/me')
  .get(
    authenticate,
    asyncHandler(async (req, res) => {
      res.status(200).json(authService.publicUser(req.user));
    })
  )
  .all(methodNotAllowed('GET'));

// POST /api/auth/password/change — смена пароля; остальные сессии закрываются.
router
  .route('/password/change')
  .post(
    authenticate,
    authLimiter,
    requireJson,
    asyncHandler(async (req, res) => {
      await authService.changePassword(req.user, req.sessionId, v.validateChangePassword(req.body), context(req));
      res.status(204).end();
    })
  )
  .all(methodNotAllowed('POST'));

// GET /api/auth/sessions — активные подключения текущего пользователя.
// DELETE /api/auth/sessions — завершить все сессии, кроме текущей.
router
  .route('/sessions')
  .get(
    authenticate,
    asyncHandler(async (req, res) => {
      const sessions = await sessionRepository.listActive(req.user.id);
      res.set('Cache-Control', 'no-store');
      res.status(200).json({
        items: sessions.map((session) => ({ ...session, current: session.id === req.sessionId })),
        limit: auth.maxSessionsPerUser
      });
    })
  )
  .delete(
    authenticate,
    asyncHandler(async (req, res) => {
      const revoked = await sessionRepository.revokeAll(req.user.id, 'user_revoked_others', req.sessionId);
      securityEvent(req.log, 'auth.session.revoked_others', { userId: req.user.id, revoked });
      res.status(204).end();
    })
  )
  .all(methodNotAllowed('GET', 'DELETE'));

// DELETE /api/auth/sessions/:id — завершить одну из своих сессий (например, забытый компьютер).
router
  .route('/sessions/:id')
  .delete(
    authenticate,
    asyncHandler(async (req, res) => {
      const id = assertUuid(req.params.id, 'Идентификатор сессии');
      // Чужая сессия для пользователя «не существует» — 404, а не 403.
      const revoked = await sessionRepository.revoke(id, 'user_revoked', req.user.id);
      if (!revoked) throw HttpError.notFound('Активная сессия не найдена');
      securityEvent(req.log, 'auth.session.revoked', { userId: req.user.id, sessionId: id });
      if (id === req.sessionId) res.clearCookie(auth.refreshCookieName, cookieOptions());
      res.status(204).end();
    })
  )
  .all(methodNotAllowed('DELETE'));

module.exports = router;
