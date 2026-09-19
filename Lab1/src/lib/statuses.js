'use strict';

// Единый справочник статусов: используется и в валидации, и в шаблонах.
const STATUSES = [
  { value: 'todo', label: 'К выполнению' },
  { value: 'in_progress', label: 'В работе' },
  { value: 'done', label: 'Выполнено' }
];

const STATUS_VALUES = STATUSES.map((s) => s.value);
const DEFAULT_STATUS = 'todo';

function isValidStatus(value) {
  return STATUS_VALUES.includes(value);
}

function statusLabel(value) {
  const found = STATUSES.find((s) => s.value === value);
  return found ? found.label : value;
}

module.exports = { STATUSES, STATUS_VALUES, DEFAULT_STATUS, isValidStatus, statusLabel };
