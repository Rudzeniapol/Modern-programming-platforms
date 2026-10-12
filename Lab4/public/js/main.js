// Точка входа клиента: связывает соединение, локальное состояние, отрисовку и интерфейс.
//
// Жизненный цикл:
//  1. Загружаем сохранённое состояние (если было) и сразу рисуем поле — даже без сети.
//  2. Подключаемся по WebSocket и отправляем hello { token, roundId, lastSeq }.
//  3. welcome: сервер присылает либо снимок поля, либо только пропущенные изменения;
//     после этого повторно отправляем ходы, накопившиеся офлайн.
//  4. Клик по клетке — ход применяется на экране сразу (оптимистично) и уходит на сервер;
//     ответ paintResult подтверждает его или откатывает при конфликте.

import { Connection } from './connection.js';
import { BoardRenderer } from './renderer.js';
import { GameState } from './state.js';
import { UI } from './ui.js';
import { uuid } from './util.js';

const CURSOR_SEND_MS = 80;

const state = new GameState();
const ui = new UI();
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const connection = new Connection(wsUrl);

let ready = false; // welcome получен, поле синхронизировано
let scores = null;
let online = null;
let history = [];
let offlineCopy = false;
let replay = null; // итоги повторной отправки офлайн-ходов
let lastCursorSentAt = 0;
let cursorTimer = null;

const renderer = new BoardRenderer(document.getElementById('board'), state, {
  onCellClick: paint,
  onHover: (cell) => ui.setCellInfo(state, cell),
  onCursorMove: sendCursor
});

// ---------------------------------------------------------------- старт

if (state.load()) {
  offlineCopy = true;
  renderer.resize();
  ui.renderPlayer(state);
}
ui.setCellInfo(state, null);
connection.addEventListener('status', onStatus);
connection.addEventListener('message', (event) => onMessage(event.detail));
connection.connect();

// Таймер раунда, заряды и строка статуса обновляются 4 раза в секунду.
setInterval(() => {
  ui.setRoundTimer(state.round, state.serverNow());
  ui.renderPlayer(state);
  if (connection.status !== 'open') refreshStatus();
}, 250);

// Сохраняем состояние, когда вкладку закрывают или прячут.
window.addEventListener('pagehide', () => state.save());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') state.save();
});

// ---------------------------------------------------------------- соединение

function refreshStatus() {
  ui.setConnection(connection.status, {
    retryAt: connection.retryAt,
    latency: connection.latency,
    pending: state.pending.length,
    offlineCopy: offlineCopy && !ready
  });
}

function onStatus(event) {
  const { status } = event.detail;
  if (status === 'open') {
    connection.send({
      type: 'hello',
      token: state.token,
      roundId: state.round ? state.round.id : null,
      lastSeq: state.round ? state.seq : null
    });
  } else {
    ready = false;
  }
  refreshStatus();
}

function onMessage(message) {
  switch (message.type) {
    case 'welcome':
      return onWelcome(message);
    case 'joined':
      return onJoined(message);
    case 'paintResult':
      return onPaintResult(message);
    case 'pixel':
      state.applyPixel(message);
      if (!state.player || message.playerId !== state.player.id)
        renderer.flash(message.x, message.y, 'remote');
      return renderer.requestDraw();
    case 'cursor':
      return renderer.setCursor(message.id, message);
    case 'cursorGone':
      return renderer.removeCursor(message.id);
    case 'presence':
      online = message.online;
      return ui.renderOnline(state, online);
    case 'scores':
      scores = message.scores;
      return ui.renderScores(state, scores);
    case 'roundEnd':
      history = [
        {
          id: message.roundId,
          winnerTeam: message.winnerTeam,
          finishedAt: Date.now(),
          scores: message.scores
        },
        ...history
      ].slice(0, 5);
      ui.renderHistory(state, history);
      return ui.showRoundEnd(state, message);
    case 'roundStart':
      return onRoundStart(message);
    case 'pong':
      return refreshStatus();
    case 'error':
      if (message.code === 'not_joined') return undefined;
      return ui.toast(message.message, 'error');
    default:
      return undefined;
  }
}

function onWelcome(message) {
  state.clockOffset = message.serverTime - Date.now();
  const { config } = message;
  const sizeChanged =
    !state.board || state.board.width !== config.width || state.board.height !== config.height;
  state.config = config;
  if (sizeChanged) state.initBoard(config.width, config.height);

  // Пока клиент был офлайн, раунд мог закончиться: его ходы к новому полю не относятся.
  if (state.round && state.round.id !== message.round.id && state.pending.length) {
    ui.toast(
      `Пока вас не было, раунд сменился — ${state.pending.length} неотправленных ходов отменено`,
      'warn',
      6000
    );
    state.pending = [];
  }
  state.round = message.round;
  state.applySync(message.sync);

  if (message.player) {
    state.player = message.player;
  } else if (message.tokenRejected) {
    ui.toast('Сервер не узнал вашего игрока — войдите заново', 'warn');
    state.forgetPlayer();
  }

  scores = message.scores;
  online = message.online;
  ready = true;
  offlineCopy = false;

  renderer.resize();
  ui.renderPlayer(state);
  ui.renderScores(state, scores);
  ui.renderOnline(state, online);
  history = message.history;
  ui.renderHistory(state, history);
  ui.setCellInfo(state, null);
  refreshStatus();
  state.save();

  if (!state.player) {
    ui.openJoin(state, { online, onSubmit: join });
    return;
  }
  resendPending();
}

/** Повторная отправка ходов, сделанных без связи. actionId не даст серверу применить ход дважды. */
function resendPending() {
  if (!state.pending.length) return;
  replay = { total: state.pending.length, ok: 0, conflict: 0, other: 0 };
  for (const action of state.pending) connection.send({ type: 'paint', ...action });
}

// ---------------------------------------------------------------- вход в игру

function join({ name, team }) {
  if (!ready) {
    ui.setJoinError('Нет соединения с сервером — подождите переподключения');
    return;
  }
  connection.send({ type: 'join', name, team });
}

function onJoined(message) {
  state.token = message.token;
  state.player = message.player;
  state.save();
  ui.closeJoin();
  ui.renderPlayer(state);
  ui.setCellInfo(state, null);
  ui.toast(`Вы в команде «${state.config.teams[state.player.team].name}». Захватывайте поле!`, 'success');
}

// ---------------------------------------------------------------- ходы

function paint(x, y) {
  if (!state.config || !state.round) return;
  if (!state.player) {
    if (ready) ui.openJoin(state, { online, onSubmit: join });
    return;
  }
  if (state.pendingAt(x, y)) {
    ui.toast('Ход в эту клетку уже ждёт подтверждения', 'info', 2000);
    return;
  }
  const cell = state.cell(x, y);
  if (cell.team === state.player.team) return; // клетка уже наша
  if (state.charges().charges < 1) {
    ui.toast('Заряды закончились — подождите, они восстанавливаются', 'warn', 2000);
    return;
  }

  // baseVersion — версия клетки, которую видит игрок. Если к моменту обработки
  // на сервере она изменится, ход будет отклонён как конфликт.
  const action = { actionId: uuid(), x, y, baseVersion: cell.version, roundId: state.round.id };
  state.addPending(action);
  state.spendCharge();
  renderer.requestDraw();
  ui.renderPlayer(state);
  if (ready) connection.send({ type: 'paint', ...action });
  else refreshStatus();
}

function onPaintResult(result) {
  // Ошибка на сервере (например, БД недоступна) — ход остаётся в очереди, пробуем снова.
  if (result.status === 'error') {
    setTimeout(() => {
      const action = state.pending.find((a) => a.actionId === result.actionId);
      if (action && ready) connection.send({ type: 'paint', ...action });
    }, 2000);
    return;
  }

  const action = state.takePending(result.actionId);
  if (result.player) state.player = result.player;
  if (result.cell)
    state.setCell(
      result.cell.x,
      result.cell.y,
      result.cell.team,
      result.cell.version,
      result.cell.playerName
    );

  if (result.status === 'conflict' && action) {
    renderer.flash(action.x, action.y, 'conflict');
    if (!replay) {
      const who = result.cell && result.cell.playerName ? `игрок ${result.cell.playerName}` : 'другой игрок';
      ui.toast(
        `Конфликт: клетку (${action.x}, ${action.y}) только что перекрасил ${who}. Ход отменён, заряд возвращён.`,
        'warn'
      );
    }
  } else if (result.status === 'no_charges' && !replay) {
    ui.toast('Сервер отклонил ход: нет зарядов', 'warn');
  }

  if (replay && action) {
    if (result.status === 'ok') replay.ok += 1;
    else if (result.status === 'conflict') replay.conflict += 1;
    else replay.other += 1;
    if (replay.ok + replay.conflict + replay.other >= replay.total) {
      const parts = [`применено ${replay.ok}`];
      if (replay.conflict)
        parts.push(`отклонено из-за конфликтов ${replay.conflict} (эти клетки изменились, пока вас не было)`);
      if (replay.other) parts.push(`отклонено по другим причинам ${replay.other}`);
      ui.toast(`Офлайн-ходы отправлены: ${parts.join(', ')}.`, replay.conflict ? 'warn' : 'success', 7000);
      replay = null;
    }
  }

  renderer.requestDraw();
  ui.renderPlayer(state);
}

function onRoundStart(message) {
  state.round = message.round;
  state.pending = [];
  state.applySync(message.sync);
  scores = message.scores;
  renderer.resize();
  ui.renderScores(state, scores);
  ui.setRoundTimer(state.round, state.serverNow());
  ui.renderPlayer(state);
}

// ---------------------------------------------------------------- курсор

function sendCursor(fx, fy) {
  if (!ready || !state.player) return;
  clearTimeout(cursorTimer);
  const now = Date.now();
  const message = { type: 'cursor', x: Math.round(fx * 10) / 10, y: Math.round(fy * 10) / 10 };
  if (now - lastCursorSentAt >= CURSOR_SEND_MS) {
    lastCursorSentAt = now;
    connection.send(message);
  } else {
    // Последнее положение всё равно должно дойти, даже если мышь остановилась.
    cursorTimer = setTimeout(() => sendCursor(fx, fy), CURSOR_SEND_MS);
  }
}

document.getElementById('board').addEventListener('pointerleave', () => {
  clearTimeout(cursorTimer);
  if (ready && state.player) connection.send({ type: 'cursor', x: null, y: null });
});
