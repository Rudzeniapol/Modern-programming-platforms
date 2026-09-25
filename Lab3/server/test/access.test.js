'use strict';

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  app,
  request,
  setupDatabase,
  resetDatabase,
  closeDatabase,
  createUser,
  createTask
} = require('./helpers');

before(setupDatabase);
beforeEach(resetDatabase);
after(closeDatabase);

describe('ролевая модель: задачи', () => {
  it('пользователь видит только свои задачи, чужая для него — 404', async () => {
    const alice = await createUser();
    const bob = await createUser();
    await createTask(alice, { title: 'Задача Алисы' });
    const bobsTask = await createTask(bob, { title: 'Задача Боба' });

    const list = await request(app).get('/api/tasks').set(alice.auth).expect(200);
    assert.deepEqual(list.body.items.map((t) => t.title), ['Задача Алисы']);
    assert.equal(list.body.counts.all, 1);

    await request(app).get(`/api/tasks/${bobsTask.id}`).set(alice.auth).expect(404);
    await request(app).patch(`/api/tasks/${bobsTask.id}`).set(alice.auth).send({ status: 'done' }).expect(404);
    await request(app).delete(`/api/tasks/${bobsTask.id}`).set(alice.auth).expect(404);
  });

  it('менеджер видит и меняет все задачи, но удалять чужие не может (403)', async () => {
    const user = await createUser();
    const manager = await createUser('manager');
    const task = await createTask(user);

    const list = await request(app).get('/api/tasks').set(manager.auth).expect(200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0].owner.id, user.id);

    const mine = await request(app).get('/api/tasks?scope=mine').set(manager.auth).expect(200);
    assert.equal(mine.body.items.length, 0);

    await request(app).patch(`/api/tasks/${task.id}`).set(manager.auth).send({ status: 'in_progress' }).expect(200);
    const denied = await request(app).delete(`/api/tasks/${task.id}`).set(manager.auth).expect(403);
    assert.equal(denied.body.code, 'forbidden');
  });

  it('администратор удаляет любую задачу', async () => {
    const user = await createUser();
    const admin = await createUser('admin');
    const task = await createTask(user);
    await request(app).delete(`/api/tasks/${task.id}`).set(admin.auth).expect(204);
    await request(app).get(`/api/tasks/${task.id}`).set(user.auth).expect(404);
  });
});

describe('ролевая модель: управление пользователями', () => {
  it('пользователь не видит список пользователей, менеджер видит, но не меняет', async () => {
    const user = await createUser();
    const manager = await createUser('manager');

    await request(app).get('/api/users').set(user.auth).expect(403);
    await request(app).get('/api/users').set(manager.auth).expect(200);
    await request(app).patch(`/api/users/${user.id}`).set(manager.auth).send({ role: 'manager' }).expect(403);
  });

  it('администратор меняет роль — права действуют сразу, без нового входа', async () => {
    const admin = await createUser('admin');
    const user = await createUser();

    await request(app).get('/api/users').set(user.auth).expect(403);
    const res = await request(app).patch(`/api/users/${user.id}`).set(admin.auth).send({ role: 'manager' }).expect(200);
    assert.equal(res.body.role, 'manager');
    await request(app).get('/api/users').set(user.auth).expect(200);
  });

  it('блокировка пользователя сразу закрывает все его сессии', async () => {
    const admin = await createUser('admin');
    const user = await createUser();

    await request(app).patch(`/api/users/${user.id}`).set(admin.auth).send({ isActive: false }).expect(200);
    await request(app).get('/api/tasks').set(user.auth).expect(401);

    const login = await request(app).post('/api/auth/login').send({ email: user.email, password: user.password }).expect(403);
    assert.equal(login.body.code, 'account_disabled');
  });

  it('администратор не может заблокировать или разжаловать сам себя (409)', async () => {
    const admin = await createUser('admin');
    await request(app).patch(`/api/users/${admin.id}`).set(admin.auth).send({ isActive: false }).expect(409);
    await request(app).patch(`/api/users/${admin.id}`).set(admin.auth).send({ role: 'user' }).expect(409);
  });

  it('проверка тела PATCH /api/users/:id', async () => {
    const admin = await createUser('admin');
    const user = await createUser();
    await request(app).patch(`/api/users/${user.id}`).set(admin.auth).send({}).expect(400);
    await request(app).patch(`/api/users/${user.id}`).set(admin.auth).send({ isActive: 'no' }).expect(400);
    await request(app).patch(`/api/users/${user.id}`).set(admin.auth).send({ role: 'root' }).expect(422);
    await request(app).patch('/api/users/00000000-0000-4000-8000-000000000000').set(admin.auth).send({ role: 'user' }).expect(404);
  });

  it('администратор видит и принудительно закрывает сессии пользователя', async () => {
    const admin = await createUser('admin');
    const user = await createUser();

    const sessions = await request(app).get(`/api/users/${user.id}/sessions`).set(admin.auth).expect(200);
    assert.equal(sessions.body.items.length, 1);

    await request(app).delete(`/api/users/${user.id}/sessions`).set(admin.auth).expect(204);
    await request(app).get('/api/tasks').set(user.auth).expect(401);
  });
});

describe('коды ответов HTTP', () => {
  it('405 с заголовком Allow и 204 на OPTIONS', async () => {
    const user = await createUser();
    const res = await request(app).put('/api/tasks').set(user.auth).expect(405);
    assert.equal(res.headers.allow, 'GET, POST, HEAD, OPTIONS');

    const options = await request(app).options('/api/auth/login').expect(204);
    assert.equal(options.headers.allow, 'POST, OPTIONS');
  });

  it('ошибки в формате application/problem+json (RFC 9457) с requestId', async () => {
    const res = await request(app).get('/api/nowhere').set('X-Request-Id', 'test-request-0001').expect(404);
    assert.match(res.headers['content-type'], /application\/problem\+json/);
    assert.equal(res.headers['x-request-id'], 'test-request-0001');
    assert.deepEqual(
      { type: res.body.type, title: res.body.title, status: res.body.status, instance: res.body.instance },
      { type: 'about:blank', title: 'Not Found', status: 404, instance: '/api/nowhere' }
    );
    assert.equal(res.body.requestId, 'test-request-0001');
  });

  it('400 на битый JSON и некорректный UUID, 422 на ошибки полей, 415 на тип тела', async () => {
    const user = await createUser();
    const broken = await request(app)
      .post('/api/tasks')
      .set(user.auth)
      .set('Content-Type', 'application/json')
      .send('{"title":')
      .expect(400);
    assert.equal(broken.body.code, 'malformed_json');

    await request(app).get('/api/tasks/not-a-uuid').set(user.auth).expect(400);
    await request(app).get('/api/tasks?sort=random').set(user.auth).expect(400);

    const invalid = await request(app).post('/api/tasks').set(user.auth).send({ title: '', dueDate: '2026-02-31' }).expect(422);
    assert.deepEqual(Object.keys(invalid.body.fields).sort(), ['dueDate', 'title']);

    await request(app).post('/api/tasks').set(user.auth).type('text/plain').send('hello').expect(415);
  });

  it('201 + Location на создание, 204 на удаление', async () => {
    const user = await createUser();
    const res = await request(app).post('/api/tasks').set(user.auth).send({ title: 'Новая' }).expect(201);
    assert.equal(res.headers.location, `/api/tasks/${res.body.id}`);
    await request(app).delete(`/api/tasks/${res.body.id}`).set(user.auth).expect(204);
  });

  it('413 на слишком большое JSON-тело', async () => {
    const user = await createUser();
    await request(app)
      .post('/api/tasks')
      .set(user.auth)
      .send({ title: 'x', description: 'a'.repeat(300 * 1024) })
      .expect(413);
  });
});
