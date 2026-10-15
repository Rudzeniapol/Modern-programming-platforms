// Мелкие помощники без зависимостей.

/** UUID v4. crypto.randomUUID есть только в защищённом контексте (https/localhost). */
export function uuid() {
  if (window.crypto.randomUUID) return window.crypto.randomUUID();
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Та же формула, что на сервере (src/game/charges.js): заряды восстанавливаются со временем. */
export function currentCharges(state, now, { maxCharges, regenMs }) {
  if (state.charges >= maxCharges) return { charges: maxCharges, chargesAt: now };
  const gained = Math.floor(Math.max(0, now - state.chargesAt) / regenMs);
  const charges = Math.min(maxCharges, state.charges + gained);
  return { charges, chargesAt: charges >= maxCharges ? now : state.chargesAt + gained * regenMs };
}

export function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export function formatTime(ms) {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Склонение по числу: plural(3, ['игрок', 'игрока', 'игроков']) → 'игрока'. */
export function plural(n, [one, few, many]) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/**
 * Команды, которые играли в завершённом раунде, — по убыванию территории.
 * Играла — значит, её игроки закрасили хотя бы одну клетку (к концу клеток может и не остаться).
 * В итогах старых версий числа игроков нет — тогда судим по клеткам.
 */
export function playedTeams(round) {
  return round.scores.teams
    .filter((team) => (team.players === undefined ? team.cells > 0 : team.players > 0))
    .sort((a, b) => b.cells - a.cells);
}

/** Создание DOM-элемента. Текст всегда через textContent — никакого innerHTML с данными игроков. */
export function el(tag, { className, text, attrs } = {}, children = []) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (attrs) for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  for (const child of children) if (child) node.append(child);
  return node;
}
