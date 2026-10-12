'use strict';

/**
 * Очередь, выполняющая асинхронные задачи строго по одной, в порядке поступления.
 *
 * Node.js однопоточный, но обработка хода содержит await (запросы к БД), и между
 * ними может «вклиниться» другой ход. Все изменения состояния игры проходят через
 * эту очередь — так два хода в одну и ту же клетку никогда не обрабатываются
 * одновременно, а порядок записи в журнал ходов совпадает с порядком применения.
 */
class SerialQueue {
  constructor() {
    this.tail = Promise.resolve();
    this.size = 0;
  }

  run(task) {
    this.size += 1;
    const result = this.tail.then(task);
    // Ошибка одной задачи не должна ломать очередь для следующих.
    this.tail = result
      .catch(() => undefined)
      .finally(() => {
        this.size -= 1;
      });
    return result;
  }
}

module.exports = { SerialQueue };
