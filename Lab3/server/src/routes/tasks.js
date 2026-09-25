'use strict';

const path = require('path');
const express = require('express');

const { uploadsDir } = require('../config');
const { taskRepository } = require('../repositories/taskRepository');
const { authenticate, requirePermission } = require('../middleware/auth');
const { uploadAttachments } = require('../middleware/upload');
const { requireContentType, requireJsonOrMultipart, requireJson } = require('../middleware/contentType');
const { methodNotAllowed } = require('../middleware/errors');
const { asyncHandler } = require('../lib/asyncHandler');
const { HttpError } = require('../lib/httpError');
const { PERMISSIONS, canOnTask, hasPermission } = require('../lib/roles');
const { validateTaskPayload, parseListQuery, assertUuid } = require('../lib/validation');

const router = express.Router();

// Все операции с задачами — только для вошедших пользователей.
router.use(authenticate);

/**
 * Валидация тела запроса. Ошибки полей уезжают клиенту в fields с кодом 422,
 * чтобы SPA подсветила конкретные поля формы, а не показала общее сообщение.
 */
function validateOrThrow(body, options) {
  const { values, errors } = validateTaskPayload(body, options);
  if (Object.keys(errors).length) {
    throw HttpError.unprocessable('Проверьте заполнение полей задачи', errors);
  }
  return values;
}

/**
 * Загружает задачу и проверяет право на действие с ней.
 *  — задачу нельзя даже прочитать → 404: пользователь не должен узнавать
 *    о существовании чужих задач по разнице между 403 и 404;
 *  — прочитать можно, а изменить/удалить нельзя → 403.
 */
async function loadTaskFor(req, action, rawId = req.params.id) {
  const id = assertUuid(rawId, 'Идентификатор задачи');
  const task = await taskRepository.findById(id);
  if (!task || !canOnTask(req.user, 'read', task)) throw HttpError.notFound(`Задача ${id} не найдена`);

  if (action !== 'read' && !canOnTask(req.user, action, task)) {
    req.log.warn({ event: 'access.denied', action, taskId: id, role: req.user.role }, 'Доступ к задаче запрещён');
    throw HttpError.forbidden(
      action === 'delete' ? 'Удалять можно только собственные задачи' : 'Изменять можно только собственные задачи'
    );
  }
  return task;
}

/**
 * То же в виде middleware: права проверяются до приёма файлов multer-ом,
 * чтобы не принимать мегабайты вложений от того, кому всё равно ответим 403/404.
 */
const withTask = (action, param = 'id') =>
  asyncHandler(async (req, res, next) => {
    req.task = await loadTaskFor(req, action, req.params[param]);
    next();
  });

router
  .route('/')
  // GET /api/tasks — список задач + счётчики для вкладок фильтра.
  // Пользователь видит только свои задачи; менеджер и администратор — все
  // (или только свои при scope=mine).
  .get(
    asyncHandler(async (req, res) => {
      const filter = parseListQuery(req.query);
      const seesAll = hasPermission(req.user, PERMISSIONS.TASKS_READ_ANY);
      const ownerId = seesAll && filter.scope === 'all' ? null : req.user.id;

      const [items, counts] = await Promise.all([
        taskRepository.list({ ...filter, ownerId }),
        taskRepository.counts({ ...filter, ownerId })
      ]);
      res.status(200).json({ items, counts, filter: { ...filter, scope: ownerId ? 'mine' : 'all' } });
    })
  )
  // POST /api/tasks — создание задачи. Принимает JSON или multipart с файлами.
  .post(
    requirePermission(PERMISSIONS.TASKS_CREATE),
    requireJsonOrMultipart,
    uploadAttachments,
    asyncHandler(async (req, res) => {
      const values = validateOrThrow(req.body);
      const task = await taskRepository.create(req.user.id, values, req.files);
      req.log.info({ event: 'task.created', taskId: task.id }, 'Задача создана');
      // 201 + Location — адрес созданного ресурса.
      res.status(201).location(`/api/tasks/${task.id}`).json(task);
    })
  )
  .all(methodNotAllowed('GET', 'POST'));

router
  .route('/:id')
  // GET /api/tasks/:id — одна задача.
  .get(withTask('read'), (req, res) => {
    res.status(200).json(req.task);
  })
  // PUT /api/tasks/:id — полная замена полей задачи (непереданные сбрасываются
  // в значения по умолчанию). Приложенные файлы добавляются к существующим.
  .put(
    requireJsonOrMultipart,
    withTask('update'),
    uploadAttachments,
    asyncHandler(async (req, res) => {
      const { task } = req;
      const values = validateOrThrow(req.body);
      const updated = await taskRepository.update(task.id, values, req.files);
      if (!updated) throw HttpError.notFound(`Задача ${task.id} не найдена`);
      req.log.info({ event: 'task.updated', taskId: task.id }, 'Задача изменена');
      res.status(200).json(updated);
    })
  )
  // PATCH /api/tasks/:id — частичное изменение (быстрая смена статуса из списка).
  .patch(
    requireJson,
    withTask('update'),
    asyncHandler(async (req, res) => {
      const { task } = req;
      const values = validateOrThrow(req.body, { partial: true });
      const updated = await taskRepository.update(task.id, values);
      if (!updated) throw HttpError.notFound(`Задача ${task.id} не найдена`);
      req.log.info({ event: 'task.updated', taskId: task.id, fields: Object.keys(values) }, 'Задача изменена');
      res.status(200).json(updated);
    })
  )
  // DELETE /api/tasks/:id — удаление задачи вместе с вложениями.
  .delete(
    withTask('delete'),
    asyncHandler(async (req, res) => {
      const { task } = req;
      const removed = await taskRepository.remove(task.id);
      if (!removed) throw HttpError.notFound(`Задача ${task.id} не найдена`);
      req.log.info({ event: 'task.deleted', taskId: task.id, ownerId: task.ownerId }, 'Задача удалена');
      // 204 No Content: удалять больше нечего, тело ответа не нужно.
      res.status(204).end();
    })
  )
  .all(methodNotAllowed('GET', 'PUT', 'PATCH', 'DELETE'));

// POST /api/tasks/:id/attachments — добавление файлов к существующей задаче.
router
  .route('/:id/attachments')
  .post(
    requireContentType('multipart/form-data'),
    withTask('update'),
    uploadAttachments,
    asyncHandler(async (req, res) => {
      const { task } = req;

      if (!req.files || !req.files.length) {
        throw HttpError.unprocessable('Не выбрано ни одного файла', {
          attachments: 'Выберите хотя бы один файл'
        });
      }

      const updated = await taskRepository.update(task.id, {}, req.files);
      if (!updated) throw HttpError.notFound(`Задача ${task.id} не найдена`);

      res.status(201).location(`/api/tasks/${task.id}`).json(updated);
    })
  )
  .all(methodNotAllowed('POST'));

router
  .route('/:taskId/attachments/:attachmentId')
  // GET — скачивание файла. На диске лежит сгенерированное имя, пользователю отдаём исходное.
  .get(
    withTask('read', 'taskId'),
    asyncHandler(async (req, res, next) => {
      const { task } = req;
      const attachmentId = assertUuid(req.params.attachmentId, 'Идентификатор вложения');

      const attachment = await taskRepository.findAttachment(task.id, attachmentId);
      if (!attachment) throw HttpError.notFound('Вложение не найдено');

      res.download(path.join(uploadsDir, attachment.storedName), attachment.originalName, (error) => {
        if (!error) return;
        if (error.code === 'ENOENT' && !res.headersSent) {
          // Запись в БД есть, а файла на диске нет — сообщаем об этом честно.
          return next(HttpError.notFound('Файл вложения отсутствует на сервере'));
        }
        return next(error);
      });
    })
  )
  // DELETE — удаление одного файла (это изменение задачи).
  .delete(
    withTask('update', 'taskId'),
    asyncHandler(async (req, res) => {
      const { task } = req;
      const attachmentId = assertUuid(req.params.attachmentId, 'Идентификатор вложения');

      const removed = await taskRepository.removeAttachment(task.id, attachmentId);
      if (!removed) throw HttpError.notFound('Вложение не найдено');

      res.status(204).end();
    })
  )
  .all(methodNotAllowed('GET', 'DELETE'));

module.exports = router;
