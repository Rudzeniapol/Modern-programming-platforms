'use strict';

const { HttpError } = require('../lib/httpError');

/**
 * Проверка Content-Type до разбора тела. Без неё express.json() просто оставил бы
 * req.body пустым, и клиент получил бы «введите название» вместо объяснения,
 * что сервер не понял формат запроса.
 */
function requireContentType(...allowed) {
  const expected = allowed.join(' или ');
  return function contentTypeGuard(req, res, next) {
    if (allowed.some((type) => req.is(type))) return next();
    return next(HttpError.unsupportedMediaType(`Тело запроса должно быть в формате ${expected}`));
  };
}

// Создание и полная замена задачи принимают и JSON, и форму с файлами.
const requireJsonOrMultipart = requireContentType('application/json', 'multipart/form-data');
// Частичное изменение (например, смена статуса) — только JSON.
const requireJson = requireContentType('application/json');

module.exports = { requireContentType, requireJsonOrMultipart, requireJson };
