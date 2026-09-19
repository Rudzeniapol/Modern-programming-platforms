'use strict';

const path = require('path');
const express = require('express');

const { uploadsDir } = require('../config');
const { taskRepository } = require('../repositories/taskRepository');
const { uploadAttachments } = require('../middleware/upload');
const { requireContentType, requireJsonOrMultipart, requireJson } = require('../middleware/contentType');
const { asyncHandler } = require('../lib/asyncHandler');
const { HttpError } = require('../lib/httpError');
const { validateTaskPayload, parseListQuery, assertUuid } = require('../lib/validation');

const router = express.Router();

/**
 * Валидация тела запроса. Ошибки полей уезжают клиенту в error.fields,
 * чтобы SPA подсветила конкретные поля формы, а не показала общее сообщение.
 */
function validateOrThrow(body, options) {
  const { values, errors } = validateTaskPayload(body, options);
  if (Object.keys(errors).length) {
    throw HttpError.badRequest('Проверьте заполнение полей задачи', errors);
  }
  return values;
}

async function loadTaskOr404(id) {
  const task = await taskRepository.findById(id);
  if (!task) throw HttpError.notFound(`Задача ${id} не найдена`);
  return task;
}

// GET /api/tasks — список задач + счётчики для вкладок фильтра.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter = parseListQuery(req.query);
    const [items, counts] = await Promise.all([
      taskRepository.list(filter),
      taskRepository.counts(filter)
    ]);
    res.status(200).json({ items, counts, filter });
  })
);

// POST /api/tasks — создание задачи. Принимает JSON или multipart с файлами.
router.post(
  '/',
  requireJsonOrMultipart,
  uploadAttachments,
  asyncHandler(async (req, res) => {
    const values = validateOrThrow(req.body);
    const task = await taskRepository.create(values, req.files);
    // 201 + Location — адрес созданного ресурса.
    res.status(201).location(`/api/tasks/${task.id}`).json(task);
  })
);

// GET /api/tasks/:id — одна задача.
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = assertUuid(req.params.id, 'Идентификатор задачи');
    res.status(200).json(await loadTaskOr404(id));
  })
);

// PUT /api/tasks/:id — полная замена полей задачи (непереданные сбрасываются
// в значения по умолчанию). Приложенные файлы добавляются к существующим.
router.put(
  '/:id',
  requireJsonOrMultipart,
  uploadAttachments,
  asyncHandler(async (req, res) => {
    const id = assertUuid(req.params.id, 'Идентификатор задачи');
    const values = validateOrThrow(req.body);

    const task = await taskRepository.update(id, values, req.files);
    if (!task) throw HttpError.notFound(`Задача ${id} не найдена`);

    res.status(200).json(task);
  })
);

// PATCH /api/tasks/:id — частичное изменение (быстрая смена статуса из списка).
router.patch(
  '/:id',
  requireJson,
  asyncHandler(async (req, res) => {
    const id = assertUuid(req.params.id, 'Идентификатор задачи');
    const values = validateOrThrow(req.body, { partial: true });

    const task = await taskRepository.update(id, values);
    if (!task) throw HttpError.notFound(`Задача ${id} не найдена`);

    res.status(200).json(task);
  })
);

// DELETE /api/tasks/:id — удаление задачи вместе с вложениями.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = assertUuid(req.params.id, 'Идентификатор задачи');
    const removed = await taskRepository.remove(id);
    if (!removed) throw HttpError.notFound(`Задача ${id} не найдена`);

    // 204 No Content: удалять больше нечего, тело ответа не нужно.
    res.status(204).end();
  })
);

// POST /api/tasks/:id/attachments — добавление файлов к существующей задаче.
router.post(
  '/:id/attachments',
  requireContentType('multipart/form-data'),
  uploadAttachments,
  asyncHandler(async (req, res) => {
    const id = assertUuid(req.params.id, 'Идентификатор задачи');

    if (!req.files || !req.files.length) {
      throw HttpError.badRequest('Не выбрано ни одного файла', {
        attachments: 'Выберите хотя бы один файл'
      });
    }

    const task = await taskRepository.update(id, {}, req.files);
    if (!task) throw HttpError.notFound(`Задача ${id} не найдена`);

    res.status(201).location(`/api/tasks/${id}`).json(task);
  })
);

// GET /api/tasks/:taskId/attachments/:attachmentId — скачивание файла.
// На диске лежит сгенерированное имя, пользователю отдаём исходное.
router.get(
  '/:taskId/attachments/:attachmentId',
  asyncHandler(async (req, res, next) => {
    const taskId = assertUuid(req.params.taskId, 'Идентификатор задачи');
    const attachmentId = assertUuid(req.params.attachmentId, 'Идентификатор вложения');

    const attachment = await taskRepository.findAttachment(taskId, attachmentId);
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
);

// DELETE /api/tasks/:taskId/attachments/:attachmentId — удаление одного файла.
router.delete(
  '/:taskId/attachments/:attachmentId',
  asyncHandler(async (req, res) => {
    const taskId = assertUuid(req.params.taskId, 'Идентификатор задачи');
    const attachmentId = assertUuid(req.params.attachmentId, 'Идентификатор вложения');

    const removed = await taskRepository.removeAttachment(taskId, attachmentId);
    if (!removed) throw HttpError.notFound('Вложение не найдено');

    res.status(204).end();
  })
);

module.exports = router;
