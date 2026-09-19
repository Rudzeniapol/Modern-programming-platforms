'use strict';

const { DEFAULT_STATUS, isValidStatus } = require('./statuses');

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value) {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * Проверяет данные формы задачи.
 * Возвращает { values, errors } — значения приводятся к нормальному виду,
 * чтобы форму можно было отрисовать заново с введёнными пользователем данными.
 */
function validateTask(body = {}) {
  const values = {
    title: String(body.title ?? '').trim(),
    description: String(body.description ?? '').trim(),
    status: String(body.status ?? DEFAULT_STATUS).trim(),
    dueDate: String(body.dueDate ?? '').trim()
  };
  const errors = {};

  if (!values.title) {
    errors.title = 'Введите название задачи';
  } else if (values.title.length > TITLE_MAX) {
    errors.title = `Название не длиннее ${TITLE_MAX} символов`;
  }

  if (values.description.length > DESCRIPTION_MAX) {
    errors.description = `Описание не длиннее ${DESCRIPTION_MAX} символов`;
  }

  if (!isValidStatus(values.status)) {
    errors.status = 'Выберите корректный статус';
    values.status = DEFAULT_STATUS;
  }

  if (values.dueDate && !isRealDate(values.dueDate)) {
    errors.dueDate = 'Некорректная дата (ожидается формат ГГГГ-ММ-ДД)';
  }

  return { values, errors, valid: Object.keys(errors).length === 0 };
}

module.exports = { validateTask, isRealDate, TITLE_MAX, DESCRIPTION_MAX };
