'use strict';

const crypto = require('crypto');
const pinoHttp = require('pino-http');

const { logger } = require('../lib/logger');

// Идентификатор, пришедший от nginx (или от клиента), принимаем только если он
// похож на безопасный токен — иначе в журнал можно было бы подсунуть что угодно.
const REQUEST_ID_RE = /^[\w.-]{8,128}$/;

/**
 * Журнал HTTP-запросов: одна JSON-запись на каждый завершённый запрос —
 * метод, путь, код ответа, время обработки, IP, пользователь и reqId.
 * reqId возвращается клиенту в X-Request-Id и попадает в тело ошибки,
 * так что жалобу пользователя легко найти в журнале.
 */
const requestLogger = pinoHttp({
  logger,
  // Дочерний логгер req.log несёт только reqId, а полное описание запроса
  // попадает в одну итоговую запись о завершении запроса.
  quietReqLogger: true,
  customAttributeKeys: { reqId: 'reqId' },
  genReqId(req, res) {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : crypto.randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  // Проба живости дёргается каждые 10 секунд — в журнале она только шумит.
  autoLogging: { ignore: (req) => req.url === '/api/health' },
  customLogLevel(req, res, error) {
    if (error || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.originalUrl || req.url} → ${res.statusCode}`,
  customErrorMessage: (req, res) => `${req.method} ${req.originalUrl || req.url} → ${res.statusCode}`,
  customProps: (req) => ({ userId: req.user ? req.user.id : undefined }),
  serializers: {
    req: (req) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      ip: req.ip,
      userAgent: req.headers['user-agent']
    }),
    res: (res) => ({ statusCode: res.statusCode })
  },
  // Сериализаторы получают исходные объекты Node, а не обёртки pino.
  wrapSerializers: false
});

module.exports = { requestLogger };
