'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const config = require('../config');
const { withTransaction } = require('../db/pool');
const { logger } = require('../lib/logger');
const { SerialQueue } = require('../lib/serialQueue');
const { currentCharges, spendCharge } = require('./charges');
const { repository } = require('./repository');

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

const SCORES_THROTTLE_MS = 500;

/**
 * Авторитетное состояние игры.
 *
 * Источник истины — PostgreSQL: каждое изменение сначала фиксируется в БД
 * (в транзакции), и только потом применяется к копии поля в памяти и рассылается
 * игрокам. Копия в памяти нужна, чтобы мгновенно отдавать снимок поля и счёт,
 * не читая БД на каждый запрос. После перезапуска сервера она восстанавливается из БД.
 *
 * События (EventEmitter) — их слушает WebSocket-хаб и рассылает клиентам:
 *   pixel      — клетка перекрашена;
 *   scores     — изменился счёт (не чаще раза в 500 мс);
 *   roundEnd   — раунд закончился, объявлен победитель;
 *   roundStart — начался новый раунд с чистым полем.
 */
class Game extends EventEmitter {
  constructor({ now = () => Date.now(), options = config } = {}) {
    super();
    this.now = now;
    this.width = options.board.width;
    this.height = options.board.height;
    this.teams = options.teams;
    this.chargeOptions = options.charges;
    this.roundOptions = options.round;
    this.maxDelta = options.sync.maxDelta;

    // Все изменения состояния выполняются строго по одному (см. lib/serialQueue.js).
    this.queue = new SerialQueue();
    this.round = null;
    this.seq = 0;
    this.roundTimer = null;
    this.scoresTimer = null;

    // Имена игроков для рассылок и таблицы лидеров.
    this.playerNames = new Map();
    this.resetBoard();
  }

  resetBoard() {
    const size = this.width * this.height;
    this.board = {
      team: new Int8Array(size).fill(-1), // -1 — пустая клетка
      version: new Int32Array(size),
      owner: new Array(size).fill(null)
    };
    this.teamCells = this.teams.map(() => 0);
    this.roundPixels = new Map(); // playerId → закрашено клеток в текущем раунде
  }

  index(x, y) {
    return y * this.width + x;
  }

  // ---------------------------------------------------------------- запуск

  async init() {
    let round = await repository.getActiveRound();
    if (!round) round = await repository.createRound(this.roundOptions.durationSec);
    this.round = round;
    this.seq = await repository.maxSeq();
    await this.loadRound();

    // Сервер мог быть выключен, когда раунд должен был закончиться.
    if (new Date(round.endsAt).getTime() <= this.now()) {
      await this.queue.run(() => this.rotateRound());
    } else {
      this.scheduleRoundEnd();
    }
    logger.info('Игра загружена из БД', {
      event: 'game.loaded',
      roundId: this.round.id,
      cells: this.teamCells.reduce((a, b) => a + b, 0),
      seq: this.seq
    });
  }

  async loadRound() {
    this.resetBoard();
    for (const cell of await repository.loadBoard(this.round.id)) {
      const i = this.index(cell.x, cell.y);
      this.board.team[i] = cell.team;
      this.board.version[i] = cell.version;
      this.board.owner[i] = cell.playerId;
      this.teamCells[cell.team] += 1;
      if (cell.playerId) this.playerNames.set(cell.playerId, cell.playerName);
    }
    for (const row of await repository.roundPixels(this.round.id)) {
      this.roundPixels.set(row.id, row.pixels);
      this.playerNames.set(row.id, row.name);
    }
  }

  stop() {
    clearTimeout(this.roundTimer);
    clearTimeout(this.scoresTimer);
  }

  // ---------------------------------------------------------------- игроки

  async createPlayer({ name, team }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const player = await repository.createPlayer({
      tokenHash: sha256(token),
      name,
      team,
      charges: this.chargeOptions.max
    });
    this.playerNames.set(player.id, player.name);
    logger.info('Новый игрок', { event: 'player.joined', playerId: player.id, team });
    return { player, token };
  }

  async findPlayerByToken(token) {
    if (!token) return null;
    const player = await repository.findPlayerByTokenHash(sha256(token));
    if (player) this.playerNames.set(player.id, player.name);
    return player;
  }

  /** Игрок в том виде, в каком его видит клиент: заряды пересчитаны на текущий момент. */
  publicPlayer(player) {
    const charges = currentCharges(player, this.now(), this.chargeOptions);
    return {
      id: player.id,
      name: player.name,
      team: player.team,
      charges: charges.charges,
      chargesAt: charges.chargesAt,
      pixelsTotal: player.pixelsTotal
    };
  }

  // ---------------------------------------------------------------- синхронизация

  snapshot() {
    const cells = [];
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        const i = this.index(x, y);
        if (this.board.team[i] >= 0) cells.push([x, y, this.board.team[i], this.board.version[i]]);
      }
    }
    return { mode: 'snapshot', seq: this.seq, cells };
  }

  /**
   * Что отправить (пере)подключившемуся клиенту.
   * Если он был в этом же раунде и отстал ненамного — только пропущенные изменения
   * (дельта из журнала ходов), иначе — снимок всего поля.
   * Вызывается внутри очереди, чтобы между расчётом и отправкой не вклинился новый ход.
   */
  async syncFor({ roundId, lastSeq }) {
    if (roundId !== this.round.id || lastSeq === null || lastSeq > this.seq) return this.snapshot();
    if (lastSeq === this.seq) return { mode: 'delta', seq: this.seq, changes: [] };

    const changes = await repository.changesSince(this.round.id, lastSeq, this.maxDelta + 1);
    if (changes.length > this.maxDelta) return this.snapshot();
    return { mode: 'delta', seq: this.seq, changes };
  }

  /** Выполнить fn, пока ни один ход не может изменить состояние. */
  consistent(fn) {
    return this.queue.run(fn);
  }

  // ---------------------------------------------------------------- ходы

  cellView(x, y) {
    const i = this.index(x, y);
    const owner = this.board.owner[i];
    return {
      x,
      y,
      team: this.board.team[i],
      version: this.board.version[i],
      playerId: owner,
      playerName: owner ? this.playerNames.get(owner) || null : null
    };
  }

  /**
   * Ход игрока. Результат:
   *   ok          — клетка перекрашена, заряд списан, изменение разослано всем;
   *   conflict    — клетку изменили после того, как игрок её увидел (версия не совпала);
   *   no_charges  — нет зарядов;
   *   rejected    — ход относится к уже закончившемуся раунду.
   * Повторная отправка того же actionId возвращает прежний результат (duplicate: true),
   * ничего не меняя.
   */
  paint(playerId, move) {
    return this.queue.run(() => this.applyPaint(playerId, move));
  }

  async applyPaint(playerId, { actionId, x, y, baseVersion, roundId }) {
    const previous = await repository.findMove(playerId, actionId);
    if (previous) {
      const player = await repository.findPlayer(playerId);
      const sameRound = previous.roundId === this.round.id;
      return {
        actionId,
        status: previous.status,
        duplicate: true,
        cell: sameRound ? this.cellView(x, y) : null,
        player: this.publicPlayer(player)
      };
    }

    if (roundId !== this.round.id) {
      const player = await repository.findPlayer(playerId);
      return {
        actionId,
        status: 'rejected',
        reason: 'round_over',
        cell: null,
        player: this.publicPlayer(player)
      };
    }

    const now = this.now();
    const i = this.index(x, y);
    const currentVersion = this.board.version[i];

    const outcome = await withTransaction(async (db) => {
      const player = await repository.lockPlayer(playerId, db);
      let charges = currentCharges(player, now, this.chargeOptions);
      let status;
      let cellVersion = currentVersion;

      // Оптимистическая блокировка: игрок видел клетку в версии baseVersion.
      // Если с тех пор её кто-то перекрасил — ход конфликтует и отклоняется.
      if (baseVersion !== currentVersion) {
        status = 'conflict';
      } else if (charges.charges < 1) {
        status = 'no_charges';
      } else {
        const written = await repository.writeCell(
          { roundId, x, y, team: player.team, playerId, baseVersion },
          db
        );
        if (written === null) {
          // Копия в памяти и БД разошлись — доверяем БД.
          status = 'conflict';
        } else {
          status = 'ok';
          cellVersion = written;
          charges = spendCharge(charges, now, this.chargeOptions);
        }
      }

      await repository.savePlayerAfterPaint(playerId, charges, status === 'ok', db);
      const seq = await repository.insertMove(
        { roundId, playerId, actionId, x, y, team: player.team, status, cellVersion },
        db
      );
      return {
        status,
        seq,
        cellVersion,
        player: { ...player, ...charges, pixelsTotal: player.pixelsTotal + (status === 'ok' ? 1 : 0) }
      };
    });

    if (outcome.status === 'ok') {
      this.applyCell(i, outcome.player.team, outcome.cellVersion, playerId);
      this.seq = outcome.seq;
      this.playerNames.set(playerId, outcome.player.name);
      this.roundPixels.set(playerId, (this.roundPixels.get(playerId) || 0) + 1);

      this.emit('pixel', {
        seq: outcome.seq,
        x,
        y,
        team: outcome.player.team,
        version: outcome.cellVersion,
        playerId,
        playerName: outcome.player.name
      });
      this.scheduleScores();
    } else if (outcome.status === 'conflict') {
      logger.info('Конфликт одновременного изменения клетки', {
        event: 'paint.conflict',
        playerId,
        x,
        y,
        baseVersion,
        currentVersion
      });
    }

    return {
      actionId,
      status: outcome.status,
      cell: this.cellView(x, y),
      player: this.publicPlayer(outcome.player)
    };
  }

  applyCell(i, team, version, playerId) {
    const previousTeam = this.board.team[i];
    if (previousTeam >= 0) this.teamCells[previousTeam] -= 1;
    this.board.team[i] = team;
    this.board.version[i] = version;
    this.board.owner[i] = playerId;
    this.teamCells[team] += 1;
  }

  // ---------------------------------------------------------------- счёт

  scores() {
    const players = [...this.roundPixels.entries()]
      .map(([id, pixels]) => ({ id, name: this.playerNames.get(id) || '—', pixels }))
      .sort((a, b) => b.pixels - a.pixels)
      .slice(0, 10);
    return {
      teams: this.teams.map((team) => ({ id: team.id, cells: this.teamCells[team.id] })),
      players,
      totalCells: this.width * this.height
    };
  }

  /** Счёт рассылается не на каждый пиксель, а не чаще раза в SCORES_THROTTLE_MS. */
  scheduleScores() {
    if (this.scoresTimer) return;
    this.scoresTimer = setTimeout(() => {
      this.scoresTimer = null;
      this.emit('scores', this.scores());
    }, SCORES_THROTTLE_MS);
  }

  // ---------------------------------------------------------------- раунды

  publicRound() {
    return {
      id: this.round.id,
      startedAt: new Date(this.round.startedAt).getTime(),
      endsAt: new Date(this.round.endsAt).getTime()
    };
  }

  async history(limit = 5) {
    const rounds = await repository.recentRounds(limit);
    return rounds.map((round) => ({
      id: round.id,
      winnerTeam: round.winnerTeam,
      finishedAt: new Date(round.finishedAt).getTime(),
      scores: round.scores
    }));
  }

  scheduleRoundEnd() {
    clearTimeout(this.roundTimer);
    const delay = Math.max(0, new Date(this.round.endsAt).getTime() - this.now());
    this.roundTimer = setTimeout(() => {
      this.queue
        .run(() => this.rotateRound())
        .catch((error) => {
          logger.error('Не удалось завершить раунд', { err: error });
          this.scheduleRoundEnd();
        });
    }, delay);
  }

  /** Подводит итоги раунда, сохраняет их и начинает новый раунд с пустым полем. */
  async rotateRound() {
    const finished = this.round;
    const result = this.scores();
    const best = Math.max(...this.teamCells);
    const leaders = this.teamCells.filter((cells) => cells === best).length;
    // Победитель — команда с наибольшей территорией; при равенстве или пустом поле — ничья.
    const winnerTeam = best > 0 && leaders === 1 ? this.teamCells.indexOf(best) : null;

    const next = await withTransaction(async (db) => {
      await repository.finishRound(finished.id, winnerTeam, result, db);
      const round = await repository.createRound(this.roundOptions.durationSec, db);
      await repository.pruneRounds(this.roundOptions.keepRounds, db);
      return round;
    });

    this.round = next;
    this.resetBoard();
    this.scheduleRoundEnd();

    logger.info('Раунд завершён', {
      event: 'round.finished',
      roundId: finished.id,
      winnerTeam,
      teams: result.teams
    });
    this.emit('roundEnd', { roundId: finished.id, winnerTeam, scores: result });
    this.emit('roundStart', { round: this.publicRound(), sync: this.snapshot(), scores: this.scores() });
  }
}

module.exports = { Game };
