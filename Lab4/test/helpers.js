'use strict';

// Окружение задаётся до подключения модулей приложения: config читает его один раз.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://pixels:pixels@localhost:55433/pixels_test';
process.env.CHARGES_MAX = '5';

const crypto = require('crypto');
const { once } = require('events');
const WebSocket = require('ws');

const { startServer } = require('../src/server');
const { pool } = require('../src/db/pool');

async function resetDatabase() {
  // Схему создаёт migrate() внутри startServer; на самом первом запуске таблиц ещё нет.
  await pool.query(`
    DO $$ BEGIN
      IF to_regclass('public.moves') IS NOT NULL THEN
        TRUNCATE moves, cells, rounds, players RESTART IDENTITY CASCADE;
      END IF;
    END $$;`);
}

/** Тестовый WebSocket-клиент: копит входящие сообщения и умеет ждать нужное. */
class TestClient {
  constructor(ws) {
    this.ws = ws;
    this.inbox = [];
    this.waiters = [];
    ws.on('message', (data) => {
      const message = JSON.parse(data.toString());
      const waiter = this.waiters.find((w) => w.match(message));
      if (waiter) {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      } else {
        this.inbox.push(message);
      }
    });
  }

  static async connect(port, path = '/ws') {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const client = new TestClient(ws);
    await once(ws, 'open');
    return client;
  }

  send(message) {
    this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  /** Следующее сообщение нужного типа (из уже полученных или будущих). */
  next(type, predicate = () => true, timeoutMs = 3000) {
    const match = (message) => message.type === type && predicate(message);
    const index = this.inbox.findIndex(match);
    if (index !== -1) return Promise.resolve(this.inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`Не дождались сообщения ${type}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async hello({ token = null, roundId = null, lastSeq = null } = {}) {
    this.send({ type: 'hello', token, roundId, lastSeq });
    return this.next('welcome');
  }

  async join(name = 'Игрок', team = 0) {
    this.send({ type: 'join', name, team });
    return this.next('joined');
  }

  paintMessage(x, y, { baseVersion = 0, roundId = 1, actionId = crypto.randomUUID() } = {}) {
    return { type: 'paint', actionId, x, y, baseVersion, roundId };
  }

  async paint(x, y, options) {
    const message = this.paintMessage(x, y, options);
    this.send(message);
    return this.next('paintResult', (m) => m.actionId === message.actionId);
  }

  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const closed = once(this.ws, 'close');
    this.ws.close();
    await closed;
  }
}

/** Новый игрок: подключиться, поздороваться, войти. */
async function newPlayer(port, name, team) {
  const client = await TestClient.connect(port);
  const welcome = await client.hello();
  const joined = await client.join(name, team);
  return { client, welcome, joined, token: joined.token, player: joined.player };
}

module.exports = { startServer, pool, resetDatabase, TestClient, newPlayer };
