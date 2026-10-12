'use strict';

const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const config = require('../config');
const { logger } = require('../lib/logger');
const { parseClientMessage, ProtocolError } = require('../game/protocol');

// Медленному клиенту, у которого скопилось столько неотправленных данных,
// перестаём слать второстепенное (курсоры), чтобы не раздувать память сервера.
const SLOW_CLIENT_BYTES = 1024 * 1024;
const PRESENCE_THROTTLE_MS = 200;
const MAX_RATE_VIOLATIONS = 200;

/**
 * WebSocket-хаб: принимает соединения, разбирает сообщения клиентов,
 * передаёт ходы в Game и рассылает всем изменения состояния.
 *
 * Сам хаб состояния игры не хранит — только список подключений.
 */
class Hub {
  constructor({ server, game, options = config }) {
    this.game = game;
    this.options = options;
    this.clients = new Set();
    this.presenceTimer = null;

    // noServer: HTTP-сервер общий с раздачей статики, апгрейд до WebSocket
    // принимаем только на пути /ws.
    this.wss = new WebSocketServer({ noServer: true, maxPayload: options.ws.maxPayload });
    server.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname !== options.ws.path) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, req));
    });

    game.on('pixel', (pixel) => this.broadcast({ type: 'pixel', ...pixel }));
    game.on('scores', (scores) => this.broadcast({ type: 'scores', scores }));
    game.on('roundEnd', (result) => this.broadcast({ type: 'roundEnd', ...result }));
    game.on('roundStart', (start) => this.broadcast({ type: 'roundStart', ...start }));

    // Heartbeat: протокол WebSocket сам не замечает «молча» оборвавшееся соединение
    // (выдернули кабель, уснул ноутбук). Сервер шлёт ping; кто не ответил pong
    // до следующего раза — отключается.
    this.heartbeat = setInterval(() => this.checkAlive(), options.ws.heartbeatMs);
    this.heartbeat.unref();
  }

  // ---------------------------------------------------------------- соединения

  onConnection(ws, req) {
    const client = {
      id: crypto.randomUUID(),
      ws,
      ip: req.socket.remoteAddress,
      player: null,
      ready: false, // получил welcome — можно слать рассылки
      alive: true,
      chain: Promise.resolve(), // сообщения одного клиента обрабатываются по порядку
      bucket: { tokens: this.options.ws.rate.burst, at: Date.now() },
      violations: 0,
      lastCursorAt: 0
    };
    this.clients.add(client);
    logger.debug('WebSocket подключён', { event: 'ws.connected', clientId: client.id, ip: client.ip });

    ws.on('pong', () => {
      client.alive = true;
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.sendError(client, 'bad_message', 'Ожидаются текстовые JSON-сообщения');
        return;
      }
      if (!this.takeToken(client)) return;
      client.chain = client.chain
        .then(() => this.handle(client, data.toString()))
        .catch((error) => this.onHandlerError(client, error));
    });

    ws.on('close', (code) => {
      this.clients.delete(client);
      logger.debug('WebSocket отключён', { event: 'ws.disconnected', clientId: client.id, code });
      if (client.player) {
        this.broadcast({ type: 'cursorGone', id: client.player.id }, client);
        this.schedulePresence();
      }
    });

    ws.on('error', (error) => logger.warn('Ошибка WebSocket', { clientId: client.id, err: error }));
  }

  checkAlive() {
    for (const client of this.clients) {
      if (!client.alive) {
        logger.info('Соединение не отвечает на ping — закрываю', {
          event: 'ws.timeout',
          clientId: client.id
        });
        client.ws.terminate();
        continue;
      }
      client.alive = false;
      client.ws.ping();
    }
  }

  /**
   * Ограничение частоты сообщений (token bucket): в «ведре» до burst жетонов,
   * пополняется perSec жетонов в секунду, каждое сообщение тратит один.
   */
  takeToken(client) {
    const { perSec, burst } = this.options.ws.rate;
    const now = Date.now();
    const bucket = client.bucket;
    bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.at) / 1000) * perSec);
    bucket.at = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    client.violations += 1;
    if (client.violations === 1 || client.violations % 50 === 0) {
      this.sendError(client, 'rate_limited', 'Слишком много сообщений — часть из них отброшена');
    }
    if (client.violations > MAX_RATE_VIOLATIONS) {
      logger.warn('Клиент отключён за флуд', { event: 'ws.flood', clientId: client.id, ip: client.ip });
      client.ws.close(1008, 'Слишком много сообщений');
    }
    return false;
  }

  // ---------------------------------------------------------------- отправка

  send(client, message) {
    if (client.ws.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(message));
  }

  sendError(client, code, message) {
    this.send(client, { type: 'error', code, message });
  }

  /** Рассылка всем, кто уже получил welcome (кроме except). */
  broadcast(message, except = null, { droppable = false } = {}) {
    const data = JSON.stringify(message);
    for (const client of this.clients) {
      if (client === except || !client.ready || client.ws.readyState !== WebSocket.OPEN) continue;
      if (droppable && client.ws.bufferedAmount > SLOW_CLIENT_BYTES) continue;
      client.ws.send(data);
    }
  }

  onlinePlayers() {
    const players = new Map();
    let spectators = 0;
    for (const client of this.clients) {
      if (!client.ready) continue;
      if (client.player) players.set(client.player.id, client.player);
      else spectators += 1;
    }
    return {
      players: [...players.values()].map(({ id, name, team }) => ({ id, name, team })),
      spectators
    };
  }

  schedulePresence() {
    if (this.presenceTimer) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.broadcast({ type: 'presence', online: this.onlinePlayers() });
    }, PRESENCE_THROTTLE_MS);
  }

  // ---------------------------------------------------------------- сообщения

  async handle(client, raw) {
    const message = parseClientMessage(raw, {
      width: this.game.width,
      height: this.game.height,
      teamCount: this.game.teams.length
    });

    switch (message.type) {
      case 'hello':
        return this.onHello(client, message);
      case 'join':
        return this.onJoin(client, message);
      case 'paint':
        return this.onPaint(client, message);
      case 'cursor':
        return this.onCursor(client, message);
      case 'ping':
        return this.send(client, { type: 'pong', t: message.t, serverTime: Date.now() });
      default:
        return undefined;
    }
  }

  /**
   * Первое сообщение после (пере)подключения. Клиент сообщает свой токен и то,
   * до какого изменения он уже знает поле (roundId + lastSeq). Сервер отвечает
   * welcome: игрок, раунд, счёт и синхронизация поля — снимок или только дельта.
   */
  async onHello(client, { token, roundId, lastSeq }) {
    if (client.ready) {
      this.sendError(client, 'already_greeted', 'hello уже был получен');
      return;
    }
    const player = await this.game.findPlayerByToken(token);
    const history = await this.game.history();

    await this.game.consistent(async () => {
      const sync = await this.game.syncFor({ roundId, lastSeq });
      client.player = player;
      this.send(client, {
        type: 'welcome',
        serverTime: Date.now(),
        config: {
          width: this.game.width,
          height: this.game.height,
          teams: this.game.teams,
          maxCharges: this.game.chargeOptions.max,
          regenMs: this.game.chargeOptions.regenMs
        },
        round: this.game.publicRound(),
        player: player ? this.game.publicPlayer(player) : null,
        // Токен был, но игрок не найден (например, БД очищена) — клиенту нужно войти заново.
        tokenRejected: Boolean(token && !player),
        sync,
        scores: this.game.scores(),
        history,
        online: this.onlinePlayers()
      });
      client.ready = true;
    });

    logger.info('Клиент синхронизирован', {
      event: 'ws.hello',
      clientId: client.id,
      playerId: player && player.id,
      resumed: roundId !== null,
      lastSeq
    });
    this.schedulePresence();
  }

  async onJoin(client, { name, team }) {
    if (!client.ready) return this.sendError(client, 'not_greeted', 'Сначала отправьте hello');
    if (client.player) return this.sendError(client, 'already_joined', 'Вы уже в игре');

    const { player, token } = await this.game.createPlayer({ name, team });
    client.player = player;
    this.send(client, { type: 'joined', token, player: this.game.publicPlayer(player) });
    this.schedulePresence();
    return undefined;
  }

  async onPaint(client, move) {
    if (!client.player) return this.sendError(client, 'not_joined', 'Чтобы рисовать, войдите в игру');
    try {
      const result = await this.game.paint(client.player.id, move);
      this.send(client, { type: 'paintResult', ...result });
    } catch (error) {
      // Например, БД недоступна. Ход не применён — клиент оставит его в очереди
      // и отправит повторно (actionId защищает от двойного применения).
      logger.error('Не удалось обработать ход', { clientId: client.id, actionId: move.actionId, err: error });
      this.send(client, { type: 'paintResult', actionId: move.actionId, status: 'error' });
    }
    return undefined;
  }

  onCursor(client, { x, y }) {
    if (!client.player) return;
    // Курсоры — самое частое и наименее важное: прореживаем и не храним.
    const now = Date.now();
    if (x !== null && now - client.lastCursorAt < this.options.ws.cursorMinIntervalMs) return;
    client.lastCursorAt = now;
    const { id, name, team } = client.player;
    this.broadcast({ type: 'cursor', id, name, team, x, y }, client, { droppable: true });
  }

  onHandlerError(client, error) {
    if (error instanceof ProtocolError) {
      this.sendError(client, error.code, error.message);
      return;
    }
    logger.error('Ошибка обработки сообщения', { clientId: client.id, err: error });
    this.sendError(client, 'internal_error', 'Внутренняя ошибка сервера. Повторите действие.');
  }

  /** Остановка сервера: клиенты получают код 1001 и переподключаются сами. */
  close() {
    clearInterval(this.heartbeat);
    clearTimeout(this.presenceTimer);
    for (const client of this.clients) client.ws.close(1001, 'Сервер перезапускается');
    // Клиент, не ответивший на закрывающий фрейм, не должен задерживать остановку.
    setTimeout(() => {
      for (const client of this.clients) client.ws.terminate();
    }, 1000).unref();
    this.wss.close();
  }
}

module.exports = { Hub };
