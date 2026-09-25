'use strict';

const http = require('http');

/**
 * Ошибка, которую можно безопасно показать клиенту.
 *
 * status  — HTTP-код ответа;
 * code    — машиночитаемый код ошибки (клиент ветвится по нему, а не по тексту);
 * fields  — пометки у конкретных полей формы;
 * headers — заголовки, которых требует семантика кода
 *           (Allow для 405, Retry-After для 429/503, WWW-Authenticate для 401).
 */
class HttpError extends Error {
  constructor(status, message, { code, fields, headers, expose = true } = {}) {
    super(message || http.STATUS_CODES[status]);
    this.name = 'HttpError';
    this.status = status;
    this.code = code || defaultCode(status);
    this.fields = fields;
    this.headers = headers || {};
    this.expose = expose;
  }

  // 400 — запрос синтаксически некорректен: битый JSON, не тот тип, лишние поля.
  static badRequest(message, options) {
    return new HttpError(400, message, { code: 'bad_request', ...options });
  }

  // 401 — клиент не аутентифицирован. RFC 6750 требует заголовок WWW-Authenticate.
  static unauthorized(message = 'Требуется вход в систему', { code = 'unauthenticated', error } = {}) {
    const challenge = error
      ? `Bearer realm="api", error="${error}"`
      : 'Bearer realm="api"';
    return new HttpError(401, message, { code, headers: { 'WWW-Authenticate': challenge } });
  }

  // 403 — клиент известен, но прав на действие у него нет.
  static forbidden(message = 'Недостаточно прав для выполнения действия', code = 'forbidden') {
    return new HttpError(403, message, { code });
  }

  static notFound(message = 'Ресурс не найден') {
    return new HttpError(404, message, { code: 'not_found' });
  }

  // 405 — ресурс существует, но метод к нему неприменим. Заголовок Allow обязателен.
  static methodNotAllowed(method, allowed) {
    return new HttpError(405, `Метод ${method} не поддерживается для этого ресурса`, {
      code: 'method_not_allowed',
      headers: { Allow: allowed.join(', ') }
    });
  }

  // 409 — запрос противоречит текущему состоянию ресурса (email уже занят и т. п.).
  static conflict(message, options) {
    return new HttpError(409, message, { code: 'conflict', ...options });
  }

  static payloadTooLarge(message, options) {
    return new HttpError(413, message, { code: 'payload_too_large', ...options });
  }

  static unsupportedMediaType(message) {
    return new HttpError(415, message, { code: 'unsupported_media_type' });
  }

  // 422 — синтаксис верный, но значения полей не проходят проверку.
  static unprocessable(message, fields) {
    return new HttpError(422, message, { code: 'validation_failed', fields });
  }

  // 429 — слишком много запросов. Retry-After — через сколько секунд можно повторить.
  static tooManyRequests(message, retryAfterSec, code = 'rate_limited') {
    return new HttpError(429, message, {
      code,
      headers: { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSec))) }
    });
  }

  static serviceUnavailable(message, retryAfterSec = 5) {
    return new HttpError(503, message, {
      code: 'service_unavailable',
      headers: { 'Retry-After': String(retryAfterSec) }
    });
  }
}

function defaultCode(status) {
  return (http.STATUS_CODES[status] || 'error').toLowerCase().replace(/[^a-z]+/g, '_');
}

module.exports = { HttpError };
