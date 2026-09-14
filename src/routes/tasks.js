'use strict';

const fs = require('fs/promises');
const path = require('path');
const express = require('express');

const store = require('../store/taskStore');
const { uploadAttachments } = require('../middleware/upload');
const { validateTask } = require('../lib/validation');
const { STATUS_VALUES, DEFAULT_STATUS } = require('../lib/statuses');
const { uploadsDir } = require('../config');

const router = express.Router();

const SORTS = ['dueDate', 'created', 'title'];

// Express 4 не перехватывает ошибки из async-обработчиков — оборачиваем вручную.
const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

function parseFilter(query = {}) {
  const status = STATUS_VALUES.includes(query.status) ? query.status : 'all';
  const sort = SORTS.includes(query.sort) ? query.sort : 'dueDate';
  return { status, sort, query: String(query.q ?? '').trim() };
}

// Текущие параметры фильтра переносим в action форм и в redirect,
// чтобы после отправки пользователь остался на том же отфильтрованном списке.
function filterToQueryString(filter, extra = {}) {
  const params = new URLSearchParams();
  if (filter.status !== 'all') params.set('status', filter.status);
  if (filter.sort !== 'dueDate') params.set('sort', filter.sort);
  if (filter.query) params.set('q', filter.query);
  for (const [key, value] of Object.entries(extra)) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function emptyForm() {
  return { title: '', description: '', status: DEFAULT_STATUS, dueDate: '' };
}

async function discardFiles(files = []) {
  await Promise.all(
    files.map((file) => fs.unlink(file.path).catch(() => undefined))
  );
}

async function renderIndex(res, filter, { form, errors = {}, notice = null, statusCode = 200 }) {
  const [tasks, counts] = await Promise.all([store.list(filter), store.counts()]);
  res.status(statusCode).render('tasks/index', {
    title: 'Список задач',
    tasks,
    counts,
    filter,
    filterQuery: filterToQueryString(filter),
    form,
    errors,
    notice
  });
}

// Список задач + форма создания
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = parseFilter(req.query);
    await renderIndex(res, filter, { form: emptyForm(), notice: req.query.notice });
  })
);

// Создание задачи (с файлами)
router.post(
  '/',
  uploadAttachments,
  asyncHandler(async (req, res) => {
    const filter = parseFilter(req.query);
    const { values, errors, valid } = validateTask(req.body);

    if (!valid) {
      await discardFiles(req.files);
      await renderIndex(res, filter, { form: values, errors, statusCode: 400 });
      return;
    }

    await store.create(values, req.files);
    res.redirect(`/tasks${filterToQueryString(filter, { notice: 'created' })}`);
  })
);

// Форма редактирования
router.get(
  '/:id/edit',
  asyncHandler(async (req, res, next) => {
    const task = await store.getById(req.params.id);
    if (!task) return next();

    const filter = parseFilter(req.query);
    res.render('tasks/edit', {
      title: `Задача: ${task.title}`,
      task,
      form: {
        title: task.title,
        description: task.description,
        status: task.status,
        dueDate: task.dueDate || ''
      },
      errors: {},
      filterQuery: filterToQueryString(filter),
      notice: req.query.notice
    });
  })
);

// Сохранение изменений (плюс добавление новых файлов)
router.post(
  '/:id',
  uploadAttachments,
  asyncHandler(async (req, res, next) => {
    const task = await store.getById(req.params.id);
    if (!task) {
      await discardFiles(req.files);
      return next();
    }

    const filter = parseFilter(req.query);
    const filterQuery = filterToQueryString(filter);
    const { values, errors, valid } = validateTask(req.body);

    if (!valid) {
      await discardFiles(req.files);
      return res.status(400).render('tasks/edit', {
        title: `Задача: ${task.title}`,
        task,
        form: values,
        errors,
        filterQuery,
        notice: null
      });
    }

    await store.update(task.id, values, req.files);
    return res.redirect(`/tasks/${task.id}/edit${filterToQueryString(filter, { notice: 'saved' })}`);
  })
);

// Быстрая смена статуса прямо из списка
router.post(
  '/:id/status',
  asyncHandler(async (req, res, next) => {
    const status = String(req.body.status ?? '');
    if (!STATUS_VALUES.includes(status)) {
      const error = new Error('Некорректный статус');
      error.status = 400;
      throw error;
    }

    const updated = await store.update(req.params.id, { status });
    if (!updated) return next();

    const filter = parseFilter(req.query);
    return res.redirect(`/tasks${filterToQueryString(filter, { notice: 'status' })}`);
  })
);

// Удаление задачи вместе с её файлами
router.post(
  '/:id/delete',
  asyncHandler(async (req, res, next) => {
    const removed = await store.remove(req.params.id);
    if (!removed) return next();

    const filter = parseFilter(req.query);
    return res.redirect(`/tasks${filterToQueryString(filter, { notice: 'deleted' })}`);
  })
);

// Скачивание вложения: на диске лежит сгенерированное имя,
// пользователю отдаём файл с исходным названием.
router.get(
  '/:taskId/attachments/:attachmentId',
  asyncHandler(async (req, res, next) => {
    const task = await store.getById(req.params.taskId);
    if (!task) return next();

    const attachment = task.attachments.find((item) => item.id === req.params.attachmentId);
    if (!attachment) return next();

    return res.download(path.join(uploadsDir, attachment.storedName), attachment.originalName, (error) => {
      if (error && !res.headersSent) next(error);
    });
  })
);

// Удаление вложения
router.post(
  '/:taskId/attachments/:attachmentId/delete',
  asyncHandler(async (req, res, next) => {
    const removed = await store.removeAttachment(req.params.taskId, req.params.attachmentId);
    if (!removed) return next();

    const filter = parseFilter(req.query);
    return res.redirect(
      `/tasks/${req.params.taskId}/edit${filterToQueryString(filter, { notice: 'file-deleted' })}`
    );
  })
);

module.exports = router;
