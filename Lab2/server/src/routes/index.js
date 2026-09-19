'use strict';

const express = require('express');

const config = require('../config');
const tasksRouter = require('./tasks');
const { STATUSES } = require('../lib/statuses');
const { SORT_VALUES, TITLE_MAX, DESCRIPTION_MAX } = require('../lib/validation');
const { asyncHandler } = require('../lib/asyncHandler');
const { query } = require('../db/pool');

const router = express.Router();

// Справочник для клиента: подписи статусов и лимиты живут на сервере
// в одном экземпляре, SPA не дублирует их у себя.
router.get('/meta', (req, res) => {
  res.status(200).json({
    statuses: STATUSES,
    sorts: SORT_VALUES,
    limits: {
      titleMax: TITLE_MAX,
      descriptionMax: DESCRIPTION_MAX,
      maxFileSize: config.upload.maxFileSize,
      maxFiles: config.upload.maxFiles
    }
  });
});

// Проба живости: используется healthcheck-ом docker-compose.
router.get(
  '/health',
  asyncHandler(async (req, res) => {
    try {
      await query('SELECT 1');
      res.status(200).json({ status: 'ok', database: 'up' });
    } catch (error) {
      res.status(503).json({ status: 'degraded', database: 'down', message: error.message });
    }
  })
);

router.use('/tasks', tasksRouter);

module.exports = router;
