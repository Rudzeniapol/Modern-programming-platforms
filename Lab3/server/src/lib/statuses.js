'use strict';

// Единый справочник статусов. Те же значения зашиты в CHECK-ограничение таблицы tasks.
const STATUSES = [
  { value: 'todo', label: 'К выполнению' },
  { value: 'in_progress', label: 'В работе' },
  { value: 'done', label: 'Выполнено' }
];

const STATUS_VALUES = STATUSES.map((status) => status.value);
const DEFAULT_STATUS = 'todo';

function isValidStatus(value) {
  return STATUS_VALUES.includes(value);
}

module.exports = { STATUSES, STATUS_VALUES, DEFAULT_STATUS, isValidStatus };
