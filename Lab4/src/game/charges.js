'use strict';

/**
 * Заряды — ограничение темпа игры: не больше max клеток подряд, затем по одной
 * каждые regenMs. Значение хранится «лениво»: (charges, chargesAt) — сколько было
 * зарядов в момент chargesAt. Восстановление досчитывается при обращении,
 * поэтому серверу не нужен таймер на каждого игрока, а после перезапуска
 * заряды восстанавливаются корректно.
 *
 * Функции чистые — время передаётся параметром, что удобно для тестов.
 */
function currentCharges(state, now, { max, regenMs }) {
  const at = Number(state.chargesAt);
  if (state.charges >= max) return { charges: max, chargesAt: now };

  const gained = Math.floor(Math.max(0, now - at) / regenMs);
  const charges = Math.min(max, state.charges + gained);
  // Остаток неполного интервала не теряется: отсчёт продолжается с at + gained·regenMs.
  return { charges, chargesAt: charges >= max ? now : at + gained * regenMs };
}

/** Тратит один заряд; null — если зарядов нет. */
function spendCharge(state, now, options) {
  const current = currentCharges(state, now, options);
  if (current.charges < 1) return null;
  return { charges: current.charges - 1, chargesAt: current.chargesAt };
}

module.exports = { currentCharges, spendCharge };
