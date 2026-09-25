'use strict';

const express = require('express');

const config = require('../config');
const authRouter = require('./auth');
const tasksRouter = require('./tasks');
const usersRouter = require('./users');
const { STATUSES } = require('../lib/statuses');
const { ROLES } = require('../lib/roles');
const { PASSWORD_MIN, PASSWORD_MAX } = require('../lib/password');
const { SORT_VALUES, TITLE_MAX, DESCRIPTION_MAX } = require('../lib/validation');
const { asyncHandler } = require('../lib/asyncHandler');
const { methodNotAllowed } = require('../middleware/errors');
const { query } = require('../db/pool');

const router = express.Router();

// Справочник для клиента: подписи статусов, роли и лимиты живут на сервере
// в одном экземпляре, SPA не дублирует их у себя. Доступен без входа.
router
  .route('/meta')
  .get((req, res) => {
    res.status(200).json({
      statuses: STATUSES,
      sorts: SORT_VALUES,
      roles: ROLES.map(({ value, label, description }) => ({ value, label, description })),
      limits: {
        titleMax: TITLE_MAX,
        descriptionMax: DESCRIPTION_MAX,
        maxFileSize: config.upload.maxFileSize,
        maxFiles: config.upload.maxFiles,
        passwordMin: PASSWORD_MIN,
        passwordMax: PASSWORD_MAX,
        maxSessions: config.auth.maxSessionsPerUser
      }
    });
  })
  .all(methodNotAllowed('GET'));

// Проба живости: используется healthcheck-ом docker-compose.
// 503 + Retry-After, если база недоступна.
router
  .route('/health')
  .get(
    asyncHandler(async (req, res) => {
      try {
        await query('SELECT 1');
        res.status(200).json({ status: 'ok', database: 'up' });
      } catch (error) {
        req.log.error({ err: error }, 'Проба живости: база недоступна');
        res.status(503).set('Retry-After', '5').json({ status: 'degraded', database: 'down' });
      }
    })
  )
  .all(methodNotAllowed('GET'));

router.use('/auth', authRouter);
router.use('/tasks', tasksRouter);
router.use('/users', usersRouter);

module.exports = router;
