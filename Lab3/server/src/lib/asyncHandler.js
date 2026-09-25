'use strict';

// Express 4 не перехватывает отказы промисов из async-обработчиков —
// оборачиваем каждый маршрут, чтобы ошибка дошла до errorHandler.
const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

module.exports = { asyncHandler };
