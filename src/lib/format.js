'use strict';

// Хелперы, доступные в шаблонах через app.locals.
function formatDate(isoDate) {
  if (!isoDate) return '';
  const [year, month, day] = String(isoDate).slice(0, 10).split('-');
  return `${day}.${month}.${year}`;
}

function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatSize(bytes) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Просроченной считается незавершённая задача со сроком раньше сегодняшнего дня.
function isOverdue(task) {
  return Boolean(task.dueDate) && task.status !== 'done' && task.dueDate < today();
}

function isDueToday(task) {
  return Boolean(task.dueDate) && task.status !== 'done' && task.dueDate === today();
}

module.exports = { formatDate, formatDateTime, formatSize, today, isOverdue, isDueToday };
