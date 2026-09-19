'use strict';

/**
 * Ошибка, которую можно безопасно показать клиенту.
 * status попадает в HTTP-код ответа, fields — в пометки у конкретных полей формы.
 */
class HttpError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.fields = fields;
  }

  static badRequest(message, fields) {
    return new HttpError(400, message, fields);
  }

  static notFound(message = 'Ресурс не найден') {
    return new HttpError(404, message);
  }

  static unsupportedMediaType(message) {
    return new HttpError(415, message);
  }
}

module.exports = { HttpError };
