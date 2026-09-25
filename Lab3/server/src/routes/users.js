'use strict';

const express = require('express');

const { bruteForce } = require('../config');
const { userRepository } = require('../repositories/userRepository');
const { sessionRepository } = require('../repositories/sessionRepository');
const { loginAttemptRepository } = require('../repositories/loginAttemptRepository');
const { authenticate, requirePermission } = require('../middleware/auth');
const { requireJson } = require('../middleware/contentType');
const { methodNotAllowed } = require('../middleware/errors');
const { asyncHandler } = require('../lib/asyncHandler');
const { HttpError } = require('../lib/httpError');
const { securityEvent } = require('../lib/logger');
const { PERMISSIONS } = require('../lib/roles');
const { validateUserPatch } = require('../lib/authValidation');
const { assertUuid } = require('../lib/validation');

const router = express.Router();

router.use(authenticate);

async function loadUserOr404(rawId) {
  const id = assertUuid(rawId, 'Идентификатор пользователя');
  const user = await userRepository.findById(id);
  if (!user) throw HttpError.notFound(`Пользователь ${id} не найден`);
  return user;
}

// GET /api/users — список пользователей (менеджер и администратор).
router
  .route('/')
  .get(
    requirePermission(PERMISSIONS.USERS_READ),
    asyncHandler(async (req, res) => {
      const items = await userRepository.list({
        windowSec: bruteForce.windowSec,
        maxFailures: bruteForce.maxFailuresPerAccount,
        lockoutSec: bruteForce.lockoutSec
      });
      res.status(200).json({ items });
    })
  )
  .all(methodNotAllowed('GET'));

// PATCH /api/users/:id — смена роли и блокировка/разблокировка (только администратор).
router
  .route('/:id')
  .patch(
    requirePermission(PERMISSIONS.USERS_MANAGE),
    requireJson,
    asyncHandler(async (req, res) => {
      const target = await loadUserOr404(req.params.id);
      const patch = validateUserPatch(req.body);

      // Администратор не может разжаловать или заблокировать сам себя:
      // иначе система легко остаётся без единого администратора.
      if (target.id === req.user.id && ((patch.role && patch.role !== 'admin') || patch.isActive === false)) {
        throw HttpError.conflict('Нельзя понизить роль или заблокировать собственную учётную запись', {
          code: 'self_modification'
        });
      }

      const updated = await userRepository.update(target.id, patch);

      // Блокировка сразу закрывает все сессии — пользователь теряет доступ немедленно.
      if (patch.isActive === false) await sessionRepository.revokeAll(target.id, 'user_disabled');

      securityEvent(req.log, 'users.updated', {
        adminId: req.user.id,
        targetId: target.id,
        changes: patch,
        previous: { role: target.role, isActive: target.isActive }
      });
      res.status(200).json(updated);
    })
  )
  .all(methodNotAllowed('PATCH'));

// GET /api/users/:id/sessions — активные подключения пользователя.
// DELETE /api/users/:id/sessions — принудительно завершить их все.
router
  .route('/:id/sessions')
  .get(
    requirePermission(PERMISSIONS.USERS_MANAGE),
    asyncHandler(async (req, res) => {
      const user = await loadUserOr404(req.params.id);
      res.status(200).json({ items: await sessionRepository.listActive(user.id) });
    })
  )
  .delete(
    requirePermission(PERMISSIONS.USERS_MANAGE),
    asyncHandler(async (req, res) => {
      const user = await loadUserOr404(req.params.id);
      const revoked = await sessionRepository.revokeAll(user.id, 'admin_revoked');
      securityEvent(req.log, 'users.sessions.revoked', { adminId: req.user.id, targetId: user.id, revoked });
      res.status(204).end();
    })
  )
  .all(methodNotAllowed('GET', 'DELETE'));

// DELETE /api/users/:id/lock — снять блокировку входа после неудачных попыток.
router
  .route('/:id/lock')
  .delete(
    requirePermission(PERMISSIONS.USERS_MANAGE),
    asyncHandler(async (req, res) => {
      const user = await loadUserOr404(req.params.id);
      await loginAttemptRepository.record({ email: user.email, ip: req.ip, success: true, reason: 'admin_unlock' });
      securityEvent(req.log, 'users.unlocked', { adminId: req.user.id, targetId: user.id });
      res.status(204).end();
    })
  )
  .all(methodNotAllowed('DELETE'));

module.exports = router;
