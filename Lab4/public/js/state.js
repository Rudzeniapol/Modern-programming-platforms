// Локальная копия состояния игры + сохранение в localStorage.
//
// Благодаря сохранению:
//  — после перезагрузки страницы поле видно сразу, даже без сети;
//  — ходы, сделанные офлайн (очередь pending), не теряются и отправляются после
//    переподключения;
//  — при переподключении клиент сообщает серверу, до какого изменения (seq) он
//    уже знает поле, и получает только пропущенное.

import { currentCharges } from './util.js';

const STORAGE_KEY = 'pixel-battle:v1';
const SAVE_DELAY_MS = 300;

export class GameState {
  constructor() {
    this.token = null;
    this.player = null;
    this.config = null;
    this.round = null;
    this.seq = 0;
    this.board = null;
    this.pending = []; // ходы, ещё не подтверждённые сервером
    this.clockOffset = 0; // серверное время − локальное
    this.saveTimer = null;
  }

  // ---------------------------------------------------------------- поле

  initBoard(width, height) {
    const size = width * height;
    this.board = {
      width,
      height,
      team: new Int8Array(size).fill(-1),
      version: new Int32Array(size),
      owner: new Array(size).fill(null)
    };
  }

  index(x, y) {
    return y * this.board.width + x;
  }

  cell(x, y) {
    const i = this.index(x, y);
    return { team: this.board.team[i], version: this.board.version[i], owner: this.board.owner[i] };
  }

  /**
   * Применяет состояние клетки, только если оно новее известного.
   * Версия клетки в пределах раунда только растёт, поэтому порядок прихода
   * сообщений (ответ на ход, рассылка, дельта) не важен — побеждает бо́льшая версия.
   */
  setCell(x, y, team, version, owner = null) {
    const i = this.index(x, y);
    if (version < this.board.version[i]) return false;
    this.board.team[i] = team;
    this.board.version[i] = version;
    if (owner) this.board.owner[i] = owner;
    this.scheduleSave();
    return true;
  }

  applySync(sync) {
    if (sync.mode === 'snapshot') {
      this.initBoard(this.board.width, this.board.height);
      for (const [x, y, team, version] of sync.cells) this.setCell(x, y, team, version);
    } else {
      for (const [, x, y, team, version] of sync.changes) this.setCell(x, y, team, version);
    }
    this.seq = sync.seq;
    this.scheduleSave();
  }

  applyPixel(pixel) {
    this.setCell(pixel.x, pixel.y, pixel.team, pixel.version, pixel.playerName);
    if (pixel.seq > this.seq) this.seq = pixel.seq;
  }

  countCells() {
    let filled = 0;
    for (const team of this.board.team) if (team >= 0) filled += 1;
    return filled;
  }

  // ---------------------------------------------------------------- ходы и заряды

  serverNow() {
    return Date.now() + this.clockOffset;
  }

  charges() {
    if (!this.player || !this.config) return { charges: 0, chargesAt: 0 };
    return currentCharges(this.player, this.serverNow(), this.config);
  }

  /** Локально тратим заряд сразу (оптимистично); сервер затем пришлёт точное значение. */
  spendCharge() {
    const current = this.charges();
    this.player.charges = current.charges - 1;
    this.player.chargesAt = current.chargesAt;
  }

  addPending(action) {
    this.pending.push(action);
    this.scheduleSave();
  }

  takePending(actionId) {
    const index = this.pending.findIndex((action) => action.actionId === actionId);
    if (index === -1) return null;
    const [action] = this.pending.splice(index, 1);
    this.scheduleSave();
    return action;
  }

  pendingAt(x, y) {
    return this.pending.find((action) => action.x === x && action.y === y) || null;
  }

  // ---------------------------------------------------------------- сохранение

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY_MS);
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.board) return;

    const cells = [];
    for (let y = 0; y < this.board.height; y += 1) {
      for (let x = 0; x < this.board.width; x += 1) {
        const i = this.index(x, y);
        if (this.board.team[i] >= 0) cells.push([x, y, this.board.team[i], this.board.version[i]]);
      }
    }
    const data = {
      token: this.token,
      player: this.player,
      config: this.config,
      round: this.round,
      seq: this.seq,
      clockOffset: this.clockOffset,
      cells,
      pending: this.pending
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Приватный режим или переполнено хранилище — игра продолжает работать без сохранения.
    }
  }

  /** Восстанавливает сохранённое состояние. Возвращает true, если было что восстановить. */
  load() {
    let data;
    try {
      data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    } catch {
      data = null;
    }
    if (!data) return false;

    this.token = data.token || null;
    this.player = data.player || null;
    if (!data.config || !data.round) return false;

    this.config = data.config;
    this.round = data.round;
    this.seq = data.seq || 0;
    this.clockOffset = data.clockOffset || 0;
    this.pending = Array.isArray(data.pending) ? data.pending : [];
    this.initBoard(data.config.width, data.config.height);
    for (const [x, y, team, version] of data.cells || []) this.setCell(x, y, team, version);
    return true;
  }

  forgetPlayer() {
    this.token = null;
    this.player = null;
    this.pending = [];
    this.save();
  }
}
