'use strict';

/**
 * Протокол WebSocket: JSON-сообщения вида { type, ...поля }.
 *
 * Клиент → сервер:
 *   hello  { token|null, roundId|null, lastSeq|null }   — представиться и синхронизироваться
 *   join   { name, team }                                — стать игроком (первый вход)
 *   paint  { actionId, x, y, baseVersion, roundId }      — закрасить клетку
 *   cursor { x|null, y|null }                            — положение курсора (не сохраняется)
 *   ping   { t }                                         — замер задержки
 *
 * Сервер → клиент: welcome, joined, paintResult, pixel, cursor, cursorGone,
 *   presence, scores, roundEnd, roundStart, pong, error.
 *
 * Здесь — только проверка входящих сообщений: всё, что прислал клиент, недоверенное.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[\w-]{20,100}$/;
// Управляющие символы в имени ломают вывод и журналы.
const CONTROL_RE = /\p{Cc}/u;

const FIELDS = {
  hello: ['token', 'roundId', 'lastSeq'],
  join: ['name', 'team'],
  paint: ['actionId', 'x', 'y', 'baseVersion', 'roundId'],
  cursor: ['x', 'y'],
  ping: ['t']
};

class ProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
  }
}

const isInt = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function fail(message) {
  throw new ProtocolError('bad_message', message);
}

/**
 * Разбирает и проверяет сообщение клиента.
 * Возвращает нормализованный объект или бросает ProtocolError.
 */
function parseClientMessage(raw, { width, height, teamCount }) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    throw new ProtocolError('bad_json', 'Сообщение не является корректным JSON');
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) fail('Ожидается JSON-объект');

  const { type } = message;
  if (!Object.hasOwn(FIELDS, type))
    throw new ProtocolError('unknown_type', `Неизвестный тип сообщения: ${type}`);

  const unknown = Object.keys(message).filter((key) => key !== 'type' && !FIELDS[type].includes(key));
  if (unknown.length) fail(`Лишние поля: ${unknown.join(', ')}`);

  switch (type) {
    case 'hello': {
      const { token = null, roundId = null, lastSeq = null } = message;
      if (token !== null && (typeof token !== 'string' || !TOKEN_RE.test(token))) fail('Некорректный token');
      if (roundId !== null && !isInt(roundId, 1, 2 ** 31)) fail('Некорректный roundId');
      if (lastSeq !== null && !isInt(lastSeq, 0, Number.MAX_SAFE_INTEGER)) fail('Некорректный lastSeq');
      return { type, token, roundId, lastSeq };
    }
    case 'join': {
      const name = typeof message.name === 'string' ? message.name.trim().replace(/\s+/g, ' ') : '';
      if (name.length < 2 || name.length > 20) fail('Имя — от 2 до 20 символов');
      if (CONTROL_RE.test(name)) fail('Имя содержит недопустимые символы');
      if (!isInt(message.team, 0, teamCount - 1)) fail('Неизвестная команда');
      return { type, name, team: message.team };
    }
    case 'paint': {
      const { actionId, x, y, baseVersion, roundId } = message;
      if (typeof actionId !== 'string' || !UUID_RE.test(actionId)) fail('actionId должен быть UUID');
      if (!isInt(x, 0, width - 1) || !isInt(y, 0, height - 1)) fail('Клетка за пределами поля');
      if (!isInt(baseVersion, 0, 2 ** 31)) fail('Некорректная baseVersion');
      if (!isInt(roundId, 1, 2 ** 31)) fail('Некорректный roundId');
      return { type, actionId: actionId.toLowerCase(), x, y, baseVersion, roundId };
    }
    case 'cursor': {
      const { x = null, y = null } = message;
      if (x === null && y === null) return { type, x: null, y: null };
      const inRange = (value, max) =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
      if (!inRange(x, width) || !inRange(y, height)) fail('Курсор за пределами поля');
      return { type, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
    }
    case 'ping': {
      const t = typeof message.t === 'number' && Number.isFinite(message.t) ? message.t : null;
      return { type, t };
    }
    default:
      throw new ProtocolError('unknown_type', `Неизвестный тип сообщения: ${type}`);
  }
}

module.exports = { parseClientMessage, ProtocolError };
