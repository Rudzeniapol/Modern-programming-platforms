'use strict';

const { HttpError } = require('./httpError');
const { DEFAULT_STATUS, STATUS_VALUES, isValidStatus } = require('./statuses');

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;
const SEARCH_MAX = 200;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TASK_FIELDS = ['title', 'description', 'status', 'dueDate'];
const SORT_VALUES = ['dueDate', 'created', 'title'];
// all — все доступные пользователю задачи, mine — только собственные.
const SCOPE_VALUES = ['all', 'mine'];

// Календарная проверка: '2026-02-31' проходит по формату, но такой даты нет.
function isRealDate(value) {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Одно поле тела запроса приводим к строке.
 * multipart/form-data всегда присылает строки, а в JSON может прийти что угодно
 * (число, объект, массив при дублировании ключа) — такие значения отбраковываем.
 */
function readField(raw) {
  if (raw === undefined) return { provided: false };
  if (raw === null) return { provided: true, ok: true, value: '' };
  if (typeof raw === 'string') return { provided: true, ok: true, value: raw.trim() };
  return { provided: true, ok: false };
}

/**
 * Проверяет тело запроса на создание/изменение задачи.
 *
 * @param {object} body       разобранное тело (JSON или поля multipart-формы)
 * @param {boolean} partial   true для PATCH: проверяются только переданные поля
 * @returns {{ values: object, errors: object }}
 *          values — нормализованные данные, errors — сообщения по полям
 */
function validateTaskPayload(body, { partial = false } = {}) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const values = {};
  const errors = {};

  const unknown = Object.keys(source).filter((key) => !TASK_FIELDS.includes(key));
  if (unknown.length) {
    throw HttpError.badRequest(`Неизвестные поля в запросе: ${unknown.join(', ')}`);
  }

  const title = readField(source.title);
  if (!title.provided) {
    if (!partial) errors.title = 'Введите название задачи';
  } else if (!title.ok) {
    errors.title = 'Название должно быть строкой';
  } else if (!title.value) {
    errors.title = 'Введите название задачи';
  } else if (title.value.length > TITLE_MAX) {
    errors.title = `Название не длиннее ${TITLE_MAX} символов`;
  } else {
    values.title = title.value;
  }

  const description = readField(source.description);
  if (!description.provided) {
    // PUT заменяет ресурс целиком: непереданное описание считается пустым.
    if (!partial) values.description = '';
  } else if (!description.ok) {
    errors.description = 'Описание должно быть строкой';
  } else if (description.value.length > DESCRIPTION_MAX) {
    errors.description = `Описание не длиннее ${DESCRIPTION_MAX} символов`;
  } else {
    values.description = description.value;
  }

  const status = readField(source.status);
  if (!status.provided) {
    if (!partial) values.status = DEFAULT_STATUS;
  } else if (!status.ok) {
    errors.status = 'Статус должен быть строкой';
  } else if (!isValidStatus(status.value)) {
    errors.status = `Допустимые статусы: ${STATUS_VALUES.join(', ')}`;
  } else {
    values.status = status.value;
  }

  const dueDate = readField(source.dueDate);
  if (!dueDate.provided) {
    if (!partial) values.dueDate = null;
  } else if (!dueDate.ok) {
    errors.dueDate = 'Дата должна быть строкой в формате ГГГГ-ММ-ДД';
  } else if (!dueDate.value) {
    values.dueDate = null; // пустая строка = срок снят
  } else if (!isRealDate(dueDate.value)) {
    errors.dueDate = 'Некорректная дата (ожидается формат ГГГГ-ММ-ДД)';
  } else {
    values.dueDate = dueDate.value;
  }

  if (partial && !Object.keys(errors).length && !Object.keys(values).length) {
    throw HttpError.badRequest(
      `Не передано ни одного поля для изменения. Допустимые: ${TASK_FIELDS.join(', ')}`
    );
  }

  return { values, errors };
}

/**
 * Проверяет параметры выборки списка задач.
 * Неизвестный статус или порядок сортировки — это ошибка клиента, а не повод
 * молча подставить значение по умолчанию.
 */
function parseListQuery(query = {}) {
  const status = readField(query.status);
  const sort = readField(query.sort);
  const search = readField(query.q);
  const scope = readField(query.scope);

  if (status.provided && (!status.ok || (status.value !== 'all' && !isValidStatus(status.value)))) {
    throw HttpError.badRequest(`Параметр status: допустимы all, ${STATUS_VALUES.join(', ')}`);
  }
  if (sort.provided && (!sort.ok || !SORT_VALUES.includes(sort.value))) {
    throw HttpError.badRequest(`Параметр sort: допустимы ${SORT_VALUES.join(', ')}`);
  }
  if (scope.provided && (!scope.ok || !SCOPE_VALUES.includes(scope.value))) {
    throw HttpError.badRequest(`Параметр scope: допустимы ${SCOPE_VALUES.join(', ')}`);
  }
  if (search.provided && !search.ok) {
    throw HttpError.badRequest('Параметр q должен быть строкой');
  }
  if (search.provided && search.ok && search.value.length > SEARCH_MAX) {
    throw HttpError.badRequest(`Параметр q не длиннее ${SEARCH_MAX} символов`);
  }

  return {
    status: status.provided && status.ok ? status.value : 'all',
    sort: sort.provided && sort.ok ? sort.value : 'dueDate',
    q: search.provided && search.ok ? search.value : '',
    scope: scope.provided && scope.ok ? scope.value : 'all'
  };
}

/**
 * Идентификаторы в базе — UUID. Проверяем формат до запроса:
 * иначе Postgres ответит ошибкой приведения типа, а клиент получит 500 вместо 400.
 */
function assertUuid(value, label) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw HttpError.badRequest(`${label} должен быть корректным UUID`);
  }
  return value;
}

module.exports = {
  validateTaskPayload,
  parseListQuery,
  assertUuid,
  isRealDate,
  TITLE_MAX,
  DESCRIPTION_MAX,
  SORT_VALUES,
  SCOPE_VALUES
};
