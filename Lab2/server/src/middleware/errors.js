'use strict';

const multer = require('multer');

const { upload: uploadConfig } = require('../config');
const { formatSize } = require('../lib/format');
const { HttpError } = require('../lib/httpError');
const { discardUploads } = require('./upload');

const MULTER_MESSAGES = {
  LIMIT_FILE_SIZE: `Файл слишком большой. Максимум — ${formatSize(uploadConfig.maxFileSize)}.`,
  LIMIT_FILE_COUNT: `За один запрос можно приложить не более ${uploadConfig.maxFiles} файлов.`,
  LIMIT_UNEXPECTED_FILE: `Файлы принимаются только в поле «${uploadConfig.fieldName}».`
};

/** Единый формат тела ошибки — клиент разбирает его одним обработчиком. */
function sendError(res, status, message, fields) {
  const error = { status, message };
  if (fields && Object.keys(fields).length) error.fields = fields;
  res.status(status).json({ error });
}

function notFound(req, res) {
  sendError(res, 404, `Ресурс ${req.method} ${req.originalUrl} не найден`);
}

// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, next) {
  // Файлы multer успевает сохранить до того, как запрос отклонён,
  // поэтому при любой ошибке подчищаем диск.
  if (req.files && req.files.length) {
    discardUploads(req.files).catch(() => undefined);
  }

  if (error instanceof multer.MulterError) {
    const message = MULTER_MESSAGES[error.code] || `Ошибка загрузки файла: ${error.message}`;
    return sendError(res, 400, message, { attachments: message });
  }

  // express.json() бросает SyntaxError на битом JSON.
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return sendError(res, 400, 'Тело запроса не является корректным JSON');
  }

  if (error instanceof HttpError) {
    return sendError(res, error.status, error.message, error.fields);
  }

  // Ответ уже начал уходить (например, упала отдача файла) — остаётся только закрыть соединение.
  if (res.headersSent) return next(error);

  console.error(error);
  return sendError(res, 500, 'Внутренняя ошибка сервера. Повторите действие позже.');
}

module.exports = { notFound, errorHandler, sendError };
