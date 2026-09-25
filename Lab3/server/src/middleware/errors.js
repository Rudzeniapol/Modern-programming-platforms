'use strict';

const http = require('http');
const multer = require('multer');

const { upload: uploadConfig } = require('../config');
const { formatSize } = require('../lib/format');
const { HttpError } = require('../lib/httpError');
const { logger } = require('../lib/logger');
const { discardUploads } = require('./upload');

// Ошибки multer: превышение лимитов — это 413 Payload Too Large,
// файл в неожиданном поле — ошибка формы запроса (400).
const MULTER_ERRORS = {
  LIMIT_FILE_SIZE: [413, `Файл слишком большой. Максимум — ${formatSize(uploadConfig.maxFileSize)}.`],
  LIMIT_FILE_COUNT: [413, `За один запрос можно приложить не более ${uploadConfig.maxFiles} файлов.`],
  LIMIT_UNEXPECTED_FILE: [400, `Файлы принимаются только в поле «${uploadConfig.fieldName}».`]
};

// Коды ошибок Postgres, которые означают недоступность базы, а не ошибку в коде.
const DB_UNAVAILABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', '57P01', '57P03', '53300']);

/**
 * Тело ошибки в формате RFC 9457 «Problem Details for HTTP APIs»
 * (Content-Type: application/problem+json):
 *   type     — about:blank: смысл ошибки полностью передаёт HTTP-код;
 *   title    — стандартная фраза кода (Not Found, Unprocessable Entity…);
 *   status   — HTTP-код (дублируется, чтобы тело было самодостаточным);
 *   detail   — понятное пользователю объяснение;
 *   instance — путь запроса, на который пришла ошибка.
 * Расширения: code (машиночитаемый код), fields (ошибки полей), requestId.
 */
function sendProblem(req, res, error) {
  const { status } = error;
  const body = {
    type: 'about:blank',
    title: http.STATUS_CODES[status] || 'Error',
    status,
    detail: error.message,
    instance: req.originalUrl,
    code: error.code
  };
  if (error.fields && Object.keys(error.fields).length) body.fields = error.fields;
  if (req.id) body.requestId = req.id;

  for (const [name, value] of Object.entries(error.headers || {})) res.setHeader(name, value);
  res.status(status).type('application/problem+json').send(JSON.stringify(body));
}

function notFound(req, res) {
  sendProblem(req, res, HttpError.notFound(`Ресурс ${req.method} ${req.originalUrl} не найден`));
}

/** Приводит любую ошибку к HttpError с корректным HTTP-кодом. */
function normalize(error) {
  if (error instanceof HttpError) return error;

  if (error instanceof multer.MulterError) {
    const [status, message] = MULTER_ERRORS[error.code] || [400, `Ошибка загрузки файла: ${error.message}`];
    return new HttpError(status, message, {
      code: status === 413 ? 'payload_too_large' : 'bad_request',
      fields: { attachments: message }
    });
  }

  // Ошибки body-parser (express.json()) несут поле type.
  if (error.type === 'entity.parse.failed') {
    return HttpError.badRequest('Тело запроса не является корректным JSON', { code: 'malformed_json' });
  }
  if (error.type === 'entity.too.large') {
    return HttpError.payloadTooLarge('Тело запроса слишком большое');
  }
  if (error.type === 'encoding.unsupported' || error.type === 'charset.unsupported') {
    return HttpError.unsupportedMediaType('Неподдерживаемая кодировка тела запроса');
  }

  // Нарушение уникальности, которое не поймала проверка в коде (гонка двух запросов).
  if (error.code === '23505') {
    return HttpError.conflict('Такая запись уже существует');
  }

  if (DB_UNAVAILABLE.has(error.code)) {
    return HttpError.serviceUnavailable('База данных временно недоступна. Повторите запрос позже.');
  }

  return new HttpError(500, 'Внутренняя ошибка сервера. Повторите действие позже.', {
    code: 'internal_error',
    expose: false
  });
}

// Express отличает обработчик ошибок по четырём аргументам — next обязателен.
function errorHandler(error, req, res, next) {
  // Файлы multer успевает сохранить до того, как запрос отклонён,
  // поэтому при любой ошибке подчищаем диск.
  if (req.files && req.files.length) {
    discardUploads(req.files).catch(() => undefined);
  }

  const problem = normalize(error);
  const log = req.log || logger;

  if (problem.status >= 500) {
    // Непредвиденная ошибка: в журнал — полный стек, клиенту — только общий текст.
    log.error({ err: error, code: problem.code }, 'Необработанная ошибка при обработке запроса');
  } else {
    log.debug({ code: problem.code, status: problem.status }, problem.message);
  }

  // Ответ уже начал уходить (например, упала отдача файла) — остаётся только закрыть соединение.
  if (res.headersSent) return next(error);

  return sendProblem(req, res, problem);
}

/**
 * Для маршрутов вида router.route(path).get(…).post(…):
 * OPTIONS отвечает списком методов, остальные неподдерживаемые — 405 + Allow.
 */
function methodNotAllowed(...methods) {
  const allowed = methods.map((method) => method.toUpperCase());
  // HEAD Express обслуживает сам для любого GET-маршрута.
  if (allowed.includes('GET')) allowed.push('HEAD');
  allowed.push('OPTIONS');

  return function methodGuard(req, res, next) {
    if (req.method === 'OPTIONS') {
      res.setHeader('Allow', allowed.join(', '));
      return res.status(204).end();
    }
    return next(HttpError.methodNotAllowed(req.method, allowed));
  };
}

module.exports = { notFound, errorHandler, sendProblem, methodNotAllowed };
