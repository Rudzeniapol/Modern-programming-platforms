export function formatDate(isoDate) {
  if (!isoDate) return '';
  const [year, month, day] = String(isoDate).slice(0, 10).split('-');
  return `${day}.${month}.${year}`;
}

export function formatDateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatSize(bytes) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

export function today() {
  const date = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Просроченной считается незавершённая задача со сроком раньше сегодняшнего дня.
export function isOverdue(task) {
  return Boolean(task.dueDate) && task.status !== 'done' && task.dueDate < today();
}

export function isDueToday(task) {
  return Boolean(task.dueDate) && task.status !== 'done' && task.dueDate === today();
}
