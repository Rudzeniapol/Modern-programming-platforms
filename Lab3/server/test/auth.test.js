'use strict';

const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  app,
  request,
  pool,
  outbox,
  PASSWORD,
  setupDatabase,
  resetDatabase,
  closeDatabase,
  createUser,
  refreshCookie
} = require('./helpers');

before(setupDatabase);
beforeEach(resetDatabase);
after(closeDatabase);

const waitFor = async (predicate, timeoutMs = 2000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Условие не выполнилось вовремя');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('регистрация и вход', () => {
  it('регистрирует пользователя с ролью user и сразу выдаёт ключи', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: ' New@Example.com ', name: 'Новый', password: PASSWORD })
      .expect(201);

    assert.equal(res.body.tokenType, 'Bearer');
    assert.equal(res.body.user.email, 'new@example.com');
    assert.equal(res.body.user.role, 'user');
    assert.ok(res.body.accessToken);
    assert.equal(res.headers['cache-control'], 'no-store');

    const cookie = [].concat(res.headers['set-cookie']).find((c) => c.startsWith('refresh_token='));
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    assert.match(cookie, /Path=\/api\/auth/);
  });

  it('409 при повторной регистрации того же email', async () => {
    await createUser('user', { email: 'dup@example.com' });
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'DUP@example.com', name: 'X', password: PASSWORD })
      .expect(409);
    assert.equal(res.body.code, 'email_taken');
  });

  it('422 с ошибками по полям при слабом пароле и неверном email', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', name: '', password: 'short' })
      .expect(422)
      .expect('Content-Type', /application\/problem\+json/);
    assert.deepEqual(Object.keys(res.body.fields).sort(), ['email', 'name', 'password']);
  });

  it('400 на неизвестные поля и 415 на не-JSON', async () => {
    await request(app)
      .post('/api/auth/register')
      .send({ email: 'a@b.cd', name: 'A', password: PASSWORD, role: 'admin' })
      .expect(400);
    await request(app).post('/api/auth/login').type('form').send('email=a@b.cd').expect(415);
  });

  it('одинаковый ответ 401 для неверного пароля и несуществующего email', async () => {
    const user = await createUser();
    const wrongPassword = await request(app).post('/api/auth/login').send({ email: user.email, password: 'Wrong1234' }).expect(401);
    const unknown = await request(app).post('/api/auth/login').send({ email: 'ghost@example.com', password: 'Wrong1234' }).expect(401);
    assert.equal(wrongPassword.body.code, 'invalid_credentials');
    assert.equal(unknown.body.code, 'invalid_credentials');
  });

  it('GET /api/auth/me возвращает роль и права', async () => {
    const manager = await createUser('manager');
    const res = await request(app).get('/api/auth/me').set(manager.auth).expect(200);
    assert.equal(res.body.role, 'manager');
    assert.ok(res.body.permissions.includes('tasks:read:any'));
    assert.ok(!res.body.permissions.includes('users:manage'));
  });
});

describe('защита от подбора пароля', () => {
  it('после серии неудач блокирует вход с 429 и Retry-After, и шлёт письмо', async () => {
    const user = await createUser();

    for (let i = 0; i < 3; i += 1) {
      await request(app).post('/api/auth/login').send({ email: user.email, password: 'Wrong1234' }).expect(401);
    }

    // Даже верный пароль не принимается, пока действует блокировка.
    const locked = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD }).expect(429);
    assert.equal(locked.body.code, 'account_locked');
    assert.ok(Number(locked.headers['retry-after']) > 0);

    await waitFor(() => outbox.some((mail) => mail.to === user.email && /заблокирован/.test(mail.subject)));
  });

  it('несуществующий email блокируется так же, как существующий', async () => {
    for (let i = 0; i < 3; i += 1) {
      await request(app).post('/api/auth/login').send({ email: 'ghost@example.com', password: 'Wrong1234' }).expect(401);
    }
    const res = await request(app).post('/api/auth/login').send({ email: 'ghost@example.com', password: 'Wrong1234' }).expect(429);
    assert.equal(res.body.code, 'account_locked');
  });

  it('успешный вход обнуляет счётчик неудач', async () => {
    const user = await createUser();
    await request(app).post('/api/auth/login').send({ email: user.email, password: 'Wrong1234' }).expect(401);
    await request(app).post('/api/auth/login').send({ email: user.email, password: 'Wrong1234' }).expect(401);
    await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
    const res = await request(app).post('/api/auth/login').send({ email: user.email, password: 'Wrong1234' }).expect(401);
    assert.match(res.body.detail, /Осталось попыток: 2/);
  });

  it('администратор снимает блокировку', async () => {
    const admin = await createUser('admin');
    const user = await createUser();
    for (let i = 0; i < 3; i += 1) {
      await request(app).post('/api/auth/login').send({ email: user.email, password: 'Wrong1234' });
    }
    await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD }).expect(429);

    const list = await request(app).get('/api/users').set(admin.auth).expect(200);
    assert.ok(list.body.items.find((u) => u.id === user.id).lockedUntil);

    await request(app).delete(`/api/users/${user.id}/lock`).set(admin.auth).expect(204);
    await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
  });
});

describe('временные ключи и сессии', () => {
  it('401 с WWW-Authenticate без ключа и с поддельным ключом', async () => {
    const missing = await request(app).get('/api/tasks').expect(401);
    assert.equal(missing.headers['www-authenticate'], 'Bearer realm="api"');

    const forged = await request(app).get('/api/tasks').set('Authorization', 'Bearer aaa.bbb.ccc').expect(401);
    assert.match(forged.headers['www-authenticate'], /error="invalid_token"/);
    assert.equal(forged.body.code, 'invalid_token');
  });

  it('refresh выдаёт новую пару ключей и меняет refresh-токен', async () => {
    const user = await createUser();
    const res = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie(user.cookie)).expect(200);
    assert.ok(res.body.accessToken);
    assert.notEqual(refreshCookie(res.headers['set-cookie']), refreshCookie(user.cookie));
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.accessToken}`).expect(200);
  });

  it('повторное использование старого refresh-токена закрывает сессию', async () => {
    const user = await createUser();
    const first = refreshCookie(user.cookie);
    await request(app).post('/api/auth/refresh').set('Cookie', first).expect(200);

    // Окно гонки параллельных запросов прошло — повтор считается кражей токена.
    await pool.query("UPDATE sessions SET rotated_at = now() - interval '1 hour'");
    await request(app).post('/api/auth/refresh').set('Cookie', first).expect(401);

    // Сессия отозвана целиком: не работает и выданный ранее access-токен.
    const res = await request(app).get('/api/auth/me').set(user.auth).expect(401);
    assert.equal(res.body.code, 'session_revoked');
  });

  it('logout закрывает сессию, и её ключ больше не принимается', async () => {
    const user = await createUser();
    await request(app).post('/api/auth/logout').set(user.auth).expect(204);
    await request(app).get('/api/auth/me').set(user.auth).expect(401);
    await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie(user.cookie)).expect(401);
  });

  it('лимит активных подключений вытесняет самую старую сессию', async () => {
    const user = await createUser(); // сессия №1
    for (let i = 0; i < 3; i += 1) {
      await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD }).expect(200);
    }
    const login = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    const auth = { Authorization: `Bearer ${login.body.accessToken}` };

    const sessions = await request(app).get('/api/auth/sessions').set(auth).expect(200);
    assert.equal(sessions.body.items.length, 3);
    assert.equal(sessions.body.items.filter((s) => s.current).length, 1);

    await request(app).get('/api/auth/me').set(user.auth).expect(401);
  });

  it('пользователь завершает другую свою сессию и не может тронуть чужую', async () => {
    const user = await createUser();
    const other = await createUser();
    const second = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });
    const secondAuth = { Authorization: `Bearer ${second.body.accessToken}` };

    const { body } = await request(app).get('/api/auth/sessions').set(user.auth);
    const target = body.items.find((s) => !s.current);
    const othersSessions = await request(app).get('/api/auth/sessions').set(other.auth);

    await request(app).delete(`/api/auth/sessions/${othersSessions.body.items[0].id}`).set(user.auth).expect(404);
    await request(app).delete(`/api/auth/sessions/${target.id}`).set(user.auth).expect(204);
    await request(app).get('/api/auth/me').set(secondAuth).expect(401);
    await request(app).get('/api/auth/me').set(user.auth).expect(200);
  });
});

describe('восстановление доступа через email', () => {
  it('202 и одинаковый ответ для известного и неизвестного адреса', async () => {
    const user = await createUser();
    const known = await request(app).post('/api/auth/password/forgot').send({ email: user.email }).expect(202);
    const unknown = await request(app).post('/api/auth/password/forgot').send({ email: 'ghost@example.com' }).expect(202);
    assert.deepEqual(known.body, unknown.body);
    await waitFor(() => outbox.length === 1);
    assert.equal(outbox[0].to, user.email);
  });

  it('сброс по ссылке из письма: новый пароль, все сессии закрыты, ссылка одноразовая', async () => {
    const user = await createUser();
    await request(app).post('/api/auth/password/forgot').send({ email: user.email }).expect(202);
    await waitFor(() => outbox.length === 1);

    const token = decodeURIComponent(/token=([^\s"&<]+)/.exec(outbox[0].text)[1]);
    await request(app).post('/api/auth/password/reset').send({ token, password: 'Brand1New' }).expect(204);

    await request(app).get('/api/auth/me').set(user.auth).expect(401);
    await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD }).expect(401);
    await request(app).post('/api/auth/login').send({ email: user.email, password: 'Brand1New' }).expect(200);

    const reused = await request(app).post('/api/auth/password/reset').send({ token, password: 'Another1New' }).expect(400);
    assert.equal(reused.body.code, 'invalid_reset_token');
  });

  it('сброс пароля снимает блокировку после неудачных попыток', async () => {
    const user = await createUser();
    for (let i = 0; i < 3; i += 1) {
      await request(app).post('/api/auth/login').send({ email: user.email, password: 'Wrong1234' });
    }
    await request(app).post('/api/auth/password/forgot').send({ email: user.email }).expect(202);
    await waitFor(() => outbox.some((mail) => /Восстановление/.test(mail.subject)));
    const mail = outbox.find((m) => /Восстановление/.test(m.subject));
    const token = decodeURIComponent(/token=([^\s"&<]+)/.exec(mail.text)[1]);

    await request(app).post('/api/auth/password/reset').send({ token, password: 'Brand1New' }).expect(204);
    await request(app).post('/api/auth/login').send({ email: user.email, password: 'Brand1New' }).expect(200);
  });

  it('истёкшая ссылка не принимается', async () => {
    const user = await createUser();
    await request(app).post('/api/auth/password/forgot').send({ email: user.email }).expect(202);
    await waitFor(() => outbox.length === 1);
    await pool.query("UPDATE password_resets SET expires_at = now() - interval '1 minute'");
    const token = decodeURIComponent(/token=([^\s"&<]+)/.exec(outbox[0].text)[1]);
    await request(app).post('/api/auth/password/reset').send({ token, password: 'Brand1New' }).expect(400);
  });

  it('смена пароля закрывает остальные сессии, текущая остаётся', async () => {
    const user = await createUser();
    const second = await request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });

    await request(app)
      .post('/api/auth/password/change')
      .set(user.auth)
      .send({ currentPassword: 'Wrong1234', newPassword: 'Brand1New' })
      .expect(422);
    await request(app)
      .post('/api/auth/password/change')
      .set(user.auth)
      .send({ currentPassword: PASSWORD, newPassword: 'Brand1New' })
      .expect(204);

    await request(app).get('/api/auth/me').set(user.auth).expect(200);
    await request(app).get('/api/auth/me').set('Authorization', `Bearer ${second.body.accessToken}`).expect(401);
  });
});
