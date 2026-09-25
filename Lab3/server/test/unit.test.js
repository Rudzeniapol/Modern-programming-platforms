'use strict';

// Модульные тесты без базы данных.
process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { hashPassword, verifyPassword, checkPasswordPolicy } = require('../src/lib/password');
const { canOnTask, hasPermission, permissionsOf } = require('../src/lib/roles');
const tokens = require('../src/lib/tokens');
const { HttpError } = require('../src/lib/httpError');
const { validateLogin, validateUserPatch } = require('../src/lib/authValidation');

describe('пароли', () => {
  it('хеш проверяется и не совпадает с другим паролем', async () => {
    const hash = await hashPassword('Secret123');
    assert.match(hash, /^scrypt\$/);
    assert.equal(await verifyPassword('Secret123', hash), true);
    assert.equal(await verifyPassword('Secret124', hash), false);
    assert.equal(await verifyPassword('Secret123', 'garbage'), false);
  });

  it('политика паролей', () => {
    assert.ok(checkPasswordPolicy('short1'));
    assert.ok(checkPasswordPolicy('onlyletters'));
    assert.ok(checkPasswordPolicy('12345678'));
    assert.equal(checkPasswordPolicy('Пароль2026'), null);
  });
});

describe('роли', () => {
  const alice = { id: 'a', role: 'user' };
  const manager = { id: 'm', role: 'manager' };
  const admin = { id: 'x', role: 'admin' };
  const task = { ownerId: 'a' };

  it('user работает только со своими задачами', () => {
    assert.equal(canOnTask(alice, 'update', task), true);
    assert.equal(canOnTask({ id: 'b', role: 'user' }, 'read', task), false);
  });

  it('manager читает и меняет чужие задачи, но не удаляет', () => {
    assert.equal(canOnTask(manager, 'read', task), true);
    assert.equal(canOnTask(manager, 'update', task), true);
    assert.equal(canOnTask(manager, 'delete', task), false);
  });

  it('admin может всё', () => {
    assert.equal(canOnTask(admin, 'delete', task), true);
    assert.equal(hasPermission(admin, 'users:manage'), true);
    assert.equal(hasPermission(manager, 'users:manage'), false);
    assert.deepEqual(permissionsOf('unknown'), []);
  });
});

describe('временные ключи', () => {
  it('access-токен подписывается и проверяется', () => {
    const token = tokens.signAccessToken({ userId: 'u-1', sessionId: 's-1', role: 'user' });
    const payload = tokens.verifyAccessToken(token);
    assert.equal(payload.sub, 'u-1');
    assert.equal(payload.sid, 's-1');
    assert.throws(() => tokens.verifyAccessToken(`${token}x`));
  });

  it('refresh-токен разбирается на id сессии и секрет', () => {
    const id = '5d20b454-ab67-4f1d-953b-09d4b8ab230c';
    const secret = tokens.randomSecret();
    assert.deepEqual(tokens.parseRefreshToken(tokens.composeRefreshToken(id, secret)), { sessionId: id, secret });
    assert.equal(tokens.parseRefreshToken('garbage'), null);
    assert.equal(tokens.parseRefreshToken(undefined), null);
  });

  it('сравнение хешей за постоянное время', () => {
    const hash = tokens.sha256('value');
    assert.equal(tokens.safeEqualHex(hash, tokens.sha256('value')), true);
    assert.equal(tokens.safeEqualHex(hash, tokens.sha256('other')), false);
    assert.equal(tokens.safeEqualHex(hash, null), false);
  });
});

describe('HttpError', () => {
  it('несёт заголовки, которых требует семантика кода', () => {
    assert.equal(HttpError.unauthorized().headers['WWW-Authenticate'], 'Bearer realm="api"');
    assert.equal(HttpError.methodNotAllowed('PUT', ['GET']).headers.Allow, 'GET');
    assert.equal(HttpError.tooManyRequests('x', 12.2).headers['Retry-After'], '13');
    assert.equal(HttpError.unprocessable('x', { a: 'b' }).status, 422);
  });
});

describe('проверка тел auth-запросов', () => {
  it('нормализует email и требует оба поля', () => {
    assert.deepEqual(validateLogin({ email: ' A@B.cd ', password: 'p' }), { email: 'a@b.cd', password: 'p' });
    assert.throws(() => validateLogin({ email: 'a@b.cd' }), (error) => error.status === 422);
    assert.throws(() => validateLogin({ email: 1, password: 'p' }), (error) => error.status === 400);
    assert.throws(() => validateLogin([]), (error) => error.status === 400);
  });

  it('PATCH пользователя', () => {
    assert.deepEqual(validateUserPatch({ role: 'manager' }), { role: 'manager', isActive: undefined });
    assert.throws(() => validateUserPatch({ role: 'root' }), (error) => error.status === 422);
    assert.throws(() => validateUserPatch({ isActive: 'yes' }), (error) => error.status === 400);
  });
});
