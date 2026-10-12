'use strict';

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { startServer, pool, resetDatabase, TestClient, newPlayer } = require('./helpers');

let app;
const clients = [];

async function connect() {
  const client = await TestClient.connect(app.port);
  clients.push(client);
  return client;
}

async function player(name, team) {
  const result = await newPlayer(app.port, name, team);
  clients.push(result.client);
  return result;
}

beforeEach(async () => {
  await resetDatabase();
  app = await startServer({ port: 0 });
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  if (app) await app.stop();
  app = null;
});

after(() => pool.end());

describe('синхронизация через WebSocket', () => {
  it('новый игрок получает токен, а по токену узнаётся при повторном входе', async () => {
    const { token, player: me } = await player('Алиса', 0);
    assert.match(token, /^[\w-]{40,}$/);
    assert.equal(me.charges, 5);

    const again = await connect();
    const welcome = await again.hello({ token });
    assert.equal(welcome.player.id, me.id);
    assert.equal(welcome.player.name, 'Алиса');
  });

  it('ход одного игрока мгновенно приходит всем остальным', async () => {
    const alice = await player('Алиса', 0);
    const bob = await player('Боб', 1);
    const spectator = await connect();
    await spectator.hello();

    const result = await alice.client.paint(10, 5);
    assert.equal(result.status, 'ok');
    assert.equal(result.cell.version, 1);
    assert.equal(result.player.charges, 4);

    for (const client of [bob.client, spectator]) {
      const pixel = await client.next('pixel');
      assert.deepEqual(
        { x: pixel.x, y: pixel.y, team: pixel.team, version: pixel.version, playerName: pixel.playerName },
        { x: 10, y: 5, team: 0, version: 1, playerName: 'Алиса' }
      );
    }
    const scores = await bob.client.next('scores');
    assert.equal(scores.scores.teams[0].cells, 1);
  });

  it('видит, кто онлайн', async () => {
    const alice = await player('Алиса', 0);
    await player('Боб', 1);
    const presence = await alice.client.next('presence', (m) => m.online.players.length === 2);
    assert.deepEqual(presence.online.players.map((p) => p.name).sort(), ['Алиса', 'Боб']);
  });
});

describe('конкурентный доступ', () => {
  it('одновременные ходы в одну клетку: применяется первый, второй получает конфликт', async () => {
    const alice = await player('Алиса', 0);
    const bob = await player('Боб', 1);

    // Оба видели пустую клетку (версия 0) и отправляют ходы «одновременно».
    const [a, b] = await Promise.all([alice.client.paint(7, 7), bob.client.paint(7, 7)]);
    const results = [a, b].map((r) => r.status).sort();
    assert.deepEqual(results, ['conflict', 'ok']);

    const winner = a.status === 'ok' ? a : b;
    const loser = a.status === 'ok' ? b : a;
    // Проигравший получает актуальное состояние клетки, заряд у него не списан.
    assert.deepEqual(loser.cell, winner.cell);
    assert.equal(loser.player.charges, 5);

    const { rows } = await pool.query('SELECT version FROM cells WHERE x = 7 AND y = 7');
    assert.deepEqual(rows, [{ version: 1 }]);
  });

  it('ход по устаревшей версии клетки отклоняется, по актуальной — проходит', async () => {
    const alice = await player('Алиса', 0);
    const bob = await player('Боб', 1);
    await alice.client.paint(1, 1); // версия 1

    const stale = await bob.client.paint(1, 1, { baseVersion: 0 });
    assert.equal(stale.status, 'conflict');
    assert.equal(stale.cell.team, 0);
    assert.equal(stale.cell.playerName, 'Алиса');

    const fresh = await bob.client.paint(1, 1, { baseVersion: 1 });
    assert.equal(fresh.status, 'ok');
    assert.equal(fresh.cell.version, 2);
    assert.equal(fresh.cell.team, 1);
  });

  it('повторная отправка того же хода не применяет его дважды (идемпотентность)', async () => {
    const alice = await player('Алиса', 0);
    const actionId = crypto.randomUUID();

    const first = await alice.client.paint(2, 2, { actionId });
    const second = await alice.client.paint(2, 2, { actionId });
    assert.equal(first.status, 'ok');
    assert.equal(second.status, 'ok');
    assert.equal(second.duplicate, true);
    assert.equal(second.player.charges, 4);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM moves');
    assert.equal(rows[0].n, 1);
  });

  it('без зарядов ход отклоняется', async () => {
    const alice = await player('Алиса', 0);
    for (let x = 0; x < 5; x += 1) assert.equal((await alice.client.paint(x, 0)).status, 'ok');
    const result = await alice.client.paint(5, 0);
    assert.equal(result.status, 'no_charges');
    assert.equal(result.player.charges, 0);
  });
});

describe('потеря соединения и восстановление', () => {
  it('переподключившийся клиент получает только пропущенные изменения (дельту)', async () => {
    const alice = await player('Алиса', 0);
    const bob = await player('Боб', 1);
    await alice.client.paint(0, 0);
    const known = (await bob.client.next('pixel', (m) => m.x === 0)).seq;
    await bob.client.close();

    // Пока Боба нет, Алиса делает ещё два хода.
    await alice.client.paint(1, 0);
    await alice.client.paint(2, 0);

    const back = await connect();
    const welcome = await back.hello({ token: bob.token, roundId: 1, lastSeq: known });
    assert.equal(welcome.sync.mode, 'delta');
    assert.deepEqual(
      welcome.sync.changes.map(([, x, y, team, version]) => [x, y, team, version]),
      [
        [1, 0, 0, 1],
        [2, 0, 0, 1]
      ]
    );
    assert.equal(welcome.player.id, bob.player.id);
  });

  it('клиент из другого раунда или без истории получает снимок поля', async () => {
    const alice = await player('Алиса', 0);
    await alice.client.paint(3, 3);

    const fresh = await connect();
    const snapshot = await fresh.hello({ roundId: 99, lastSeq: 1 });
    assert.equal(snapshot.sync.mode, 'snapshot');
    assert.deepEqual(snapshot.sync.cells, [[3, 3, 0, 1]]);
  });

  it('офлайн-очередь: ходы отправляются после переподключения, изменённые клетки — конфликт', async () => {
    const alice = await player('Алиса', 0);
    const bob = await player('Боб', 1);
    await bob.client.close();

    // Боб «офлайн» сделал два хода по пустым клеткам; тем временем Алиса заняла одну из них.
    const queued = [bob.client.paintMessage(5, 5), bob.client.paintMessage(6, 5)];
    await alice.client.paint(6, 5);

    const back = await connect();
    await back.hello({ token: bob.token, roundId: 1, lastSeq: 0 });
    for (const message of queued) back.send(message);
    const results = await Promise.all(
      queued.map((m) => back.next('paintResult', (r) => r.actionId === m.actionId))
    );
    assert.deepEqual(
      results.map((r) => r.status),
      ['ok', 'conflict']
    );
  });
});

describe('сохранение между запусками', () => {
  it('поле, игроки и заряды переживают перезапуск сервера', async () => {
    const alice = await player('Алиса', 2);
    await alice.client.paint(4, 4);
    await alice.client.paint(5, 4);
    await alice.client.close();
    clients.length = 0;

    await app.stop();
    app = await startServer({ port: 0 });

    const client = await connect();
    const welcome = await client.hello({ token: alice.token });
    assert.equal(welcome.player.name, 'Алиса');
    assert.equal(welcome.player.pixelsTotal, 2);
    assert.ok(welcome.player.charges <= 5);
    assert.deepEqual(welcome.sync.cells.sort(), [
      [4, 4, 2, 1],
      [5, 4, 2, 1]
    ]);
    assert.equal(welcome.scores.teams[2].cells, 2);
    assert.equal(welcome.scores.players[0].pixels, 2);
  });

  it('раунд, истёкший пока сервер был выключен, завершается при старте', async () => {
    const alice = await player('Алиса', 1);
    await alice.client.paint(0, 0);
    await alice.client.close();
    clients.length = 0;
    await app.stop();

    await pool.query("UPDATE rounds SET ends_at = now() - interval '1 minute'");
    app = await startServer({ port: 0 });

    const { rows } = await pool.query(
      'SELECT id, winner_team, finished_at IS NOT NULL AS done FROM rounds ORDER BY id'
    );
    assert.deepEqual(rows, [
      { id: 1, winner_team: 1, done: true },
      { id: 2, winner_team: null, done: false }
    ]);
    assert.equal(app.game.round.id, 2);
  });
});

describe('раунды', () => {
  it('конец раунда: победитель, чистое поле, ходы старого раунда отклоняются', async () => {
    const alice = await player('Алиса', 3);
    const bob = await player('Боб', 0);
    await alice.client.paint(0, 0);
    await alice.client.paint(1, 0);
    await bob.client.paint(2, 0);

    await app.game.queue.run(() => app.game.rotateRound());

    const end = await bob.client.next('roundEnd');
    assert.equal(end.winnerTeam, 3);
    const start = await bob.client.next('roundStart');
    assert.equal(start.round.id, 2);
    assert.deepEqual(start.sync.cells, []);

    const late = await bob.client.paint(5, 5, { roundId: 1 });
    assert.equal(late.status, 'rejected');
    assert.equal(late.reason, 'round_over');

    const viewer = await connect();
    const welcome = await viewer.hello();
    assert.equal(welcome.history[0].winnerTeam, 3);
  });
});

describe('проверка входящих сообщений', () => {
  it('ошибки протокола не роняют соединение', async () => {
    const client = await connect();
    client.send('{not json');
    assert.equal((await client.next('error')).code, 'bad_json');

    client.send({ type: 'join', name: 'Ева', team: 0 });
    assert.equal((await client.next('error')).code, 'not_greeted');

    await client.hello();
    client.send(client.paintMessage(1, 1));
    assert.equal((await client.next('error')).code, 'not_joined');

    await client.join('Ева', 0);
    client.send({ type: 'paint', actionId: crypto.randomUUID(), x: 100, y: 1, baseVersion: 0, roundId: 1 });
    assert.equal((await client.next('error')).code, 'bad_message');

    // После всех ошибок соединение по-прежнему работает.
    assert.equal((await client.paint(1, 1)).status, 'ok');
  });

  it('флуд сообщениями ограничивается', async () => {
    const client = await connect();
    await client.hello();
    for (let i = 0; i < 120; i += 1) client.send({ type: 'ping', t: i });
    assert.equal((await client.next('error')).code, 'rate_limited');
  });
});

describe('HTTP', () => {
  const base = () => `http://127.0.0.1:${app.port}`;

  it('отдаёт клиент с заголовками безопасности и пробу живости', async () => {
    const page = await fetch(`${base()}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.match(await page.text(), /Пиксельная битва/);

    const etag = page.headers.get('etag');
    assert.equal((await fetch(`${base()}/`, { headers: { 'If-None-Match': etag } })).status, 304);

    const health = await fetch(`${base()}/api/health`);
    assert.deepEqual(await health.json(), { status: 'ok', database: 'up' });
  });

  it('405 на неподдерживаемый метод, 404 на неизвестный файл, WebSocket только на /ws', async () => {
    const post = await fetch(`${base()}/`, { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, HEAD');
    assert.equal((await fetch(`${base()}/nope.js`)).status, 404);
    await assert.rejects(TestClient.connect(app.port, '/other'));
  });
});
