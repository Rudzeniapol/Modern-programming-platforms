'use strict';

process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { currentCharges, spendCharge } = require('../src/game/charges');
const { parseClientMessage, ProtocolError } = require('../src/game/protocol');
const { SerialQueue } = require('../src/lib/serialQueue');

const OPTIONS = { max: 10, regenMs: 1000 };
const BOARD = { width: 64, height: 40, teamCount: 4 };

describe('заряды', () => {
  it('восстанавливаются по одному за интервал и не превышают максимум', () => {
    assert.deepEqual(currentCharges({ charges: 3, chargesAt: 0 }, 2500, OPTIONS), {
      charges: 5,
      chargesAt: 2000
    });
    assert.equal(currentCharges({ charges: 3, chargesAt: 0 }, 60_000, OPTIONS).charges, 10);
  });

  it('остаток неполного интервала не теряется', () => {
    // 2.5 интервала: +2 заряда, отсчёт следующего продолжается с отметки 2000, а не с 2500.
    const after = currentCharges({ charges: 0, chargesAt: 0 }, 2500, OPTIONS);
    assert.equal(currentCharges(after, 3000, OPTIONS).charges, 3);
  });

  it('трата заряда; при нуле — null', () => {
    assert.deepEqual(spendCharge({ charges: 10, chargesAt: 0 }, 5000, OPTIONS), {
      charges: 9,
      chargesAt: 5000
    });
    assert.equal(spendCharge({ charges: 0, chargesAt: 5000 }, 5500, OPTIONS), null);
  });
});

describe('протокол', () => {
  const parse = (message) => parseClientMessage(JSON.stringify(message), BOARD);
  const actionId = '5d20b454-ab67-4f1d-953b-09d4b8ab230c';

  it('принимает корректный ход', () => {
    assert.deepEqual(parse({ type: 'paint', actionId, x: 63, y: 39, baseVersion: 0, roundId: 1 }), {
      type: 'paint',
      actionId,
      x: 63,
      y: 39,
      baseVersion: 0,
      roundId: 1
    });
  });

  it('отклоняет клетки за пределами поля, лишние поля, не-UUID и неизвестные типы', () => {
    const bad = [
      { type: 'paint', actionId, x: 64, y: 0, baseVersion: 0, roundId: 1 },
      { type: 'paint', actionId, x: 1.5, y: 0, baseVersion: 0, roundId: 1 },
      { type: 'paint', actionId, x: 0, y: 0, baseVersion: 0, roundId: 1, team: 3 },
      { type: 'paint', actionId: 'abc', x: 0, y: 0, baseVersion: 0, roundId: 1 },
      { type: 'teleport' },
      [1, 2]
    ];
    for (const message of bad) assert.throws(() => parse(message), ProtocolError);
    assert.throws(
      () => parseClientMessage('{oops', BOARD),
      (error) => error.code === 'bad_json'
    );
  });

  it('нормализует имя и отклоняет управляющие символы', () => {
    assert.equal(parse({ type: 'join', name: '  Вася   Пупкин ', team: 2 }).name, 'Вася Пупкин');
    assert.throws(() => parse({ type: 'join', name: 'a', team: 0 }), ProtocolError);
    assert.throws(() => parse({ type: 'join', name: 'bad\u0007name', team: 0 }), ProtocolError);
    assert.throws(() => parse({ type: 'join', name: 'Вася', team: 4 }), ProtocolError);
  });

  it('курсор: координаты в пределах поля или null', () => {
    assert.deepEqual(parse({ type: 'cursor', x: null, y: null }), { type: 'cursor', x: null, y: null });
    assert.deepEqual(parse({ type: 'cursor', x: 1.234, y: 2 }), { type: 'cursor', x: 1.2, y: 2 });
    assert.throws(() => parse({ type: 'cursor', x: -1, y: 2 }), ProtocolError);
  });
});

describe('последовательная очередь', () => {
  it('выполняет задачи строго по одной в порядке постановки', async () => {
    const queue = new SerialQueue();
    const log = [];
    const task = (name, ms) => () =>
      new Promise((resolve) => {
        log.push(`start ${name}`);
        setTimeout(() => {
          log.push(`end ${name}`);
          resolve(name);
        }, ms);
      });
    const results = await Promise.all([
      queue.run(task('a', 20)),
      queue.run(task('b', 1)),
      queue.run(task('c', 5))
    ]);
    assert.deepEqual(results, ['a', 'b', 'c']);
    assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  });

  it('ошибка одной задачи не ломает следующие', async () => {
    const queue = new SerialQueue();
    await assert.rejects(
      queue.run(async () => {
        throw new Error('boom');
      })
    );
    assert.equal(await queue.run(async () => 42), 42);
  });
});
