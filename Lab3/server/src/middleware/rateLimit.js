'use strict';

const { HttpError } = require('../lib/httpError');

const limiters = [];

/**
 * Ограничение частоты запросов (фиксированное окно, хранение в памяти процесса).
 * Отвечает 429 Too Many Requests с Retry-After и сообщает клиенту остаток лимита
 * в заголовках RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset.
 *
 * Памяти процесса достаточно для одного экземпляра API; при горизонтальном
 * масштабировании счётчики переносятся в общее хранилище (Redis).
 */
function rateLimit({ name, windowSec, max, key = (req) => req.ip, message }) {
  const hits = new Map();
  limiters.push(hits);

  // Периодически выбрасываем истёкшие окна, чтобы Map не рос бесконечно.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of hits) if (entry.resetAt <= now) hits.delete(k);
  }, windowSec * 1000);
  sweeper.unref();

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const id = `${name}:${key(req)}`;
    let entry = hits.get(id);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowSec * 1000 };
      hits.set(id, entry);
    }
    entry.count += 1;

    const resetSec = Math.ceil((entry.resetAt - now) / 1000);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.setHeader('RateLimit-Reset', String(resetSec));

    if (entry.count > max) {
      req.log.warn({ event: 'rate_limit.exceeded', limiter: name, ip: req.ip }, 'Превышен лимит запросов');
      return next(
        HttpError.tooManyRequests(message || 'Слишком много запросов. Повторите попытку позже.', resetSec)
      );
    }
    return next();
  };
}

/** Сброс всех счётчиков — используется в автотестах. */
function resetRateLimits() {
  for (const hits of limiters) hits.clear();
}

module.exports = { rateLimit, resetRateLimits };
