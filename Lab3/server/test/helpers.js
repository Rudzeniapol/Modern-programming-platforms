'use strict';

// Окружение задаётся до подключения модулей приложения: config читает его один раз.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://tasks:tasks@localhost:55432/tasks_test';
process.env.UPLOADS_DIR = process.env.UPLOADS_DIR || require('path').join(require('os').tmpdir(), 'spp-lab3-test-uploads');
process.env.MAX_SESSIONS_PER_USER = '3';
process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT = '3';
process.env.LOGIN_MAX_FAILURES_PER_IP = '50';
process.env.RATE_LIMIT_RESET_MAX = '100';

const request = require('supertest');

const app = require('../src/app');
const { migrate } = require('../src/db/migrate');
const { pool } = require('../src/db/pool');
const { hashPassword } = require('../src/lib/password');
const { outbox } = require('../src/lib/mailer');
const { resetRateLimits } = require('../src/middleware/rateLimit');
const { userRepository } = require('../src/repositories/userRepository');

const PASSWORD = 'Secret123';

async function setupDatabase() {
  await migrate();
}

async function resetDatabase() {
  await pool.query('TRUNCATE users, sessions, login_attempts, password_resets, tasks, attachments RESTART IDENTITY CASCADE');
  outbox.length = 0;
  resetRateLimits();
}

let counter = 0;

/** Создаёт пользователя с нужной ролью и входит под ним. */
async function createUser(role = 'user', overrides = {}) {
  counter += 1;
  const email = overrides.email || `${role}${counter}@example.com`;
  const password = overrides.password || PASSWORD;
  const user = await userRepository.create({
    email,
    name: overrides.name || `${role} ${counter}`,
    role,
    passwordHash: await hashPassword(password)
  });
  const res = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  return {
    ...user,
    password,
    token: res.body.accessToken,
    cookie: res.headers['set-cookie'],
    auth: { Authorization: `Bearer ${res.body.accessToken}` }
  };
}

async function createTask(user, values = {}) {
  const res = await request(app)
    .post('/api/tasks')
    .set(user.auth)
    .send({ title: 'Задача', ...values })
    .expect(201);
  return res.body;
}

/** Достаёт значение refresh-токена из заголовков Set-Cookie. */
function refreshCookie(setCookie = []) {
  const header = [].concat(setCookie).find((value) => value.startsWith('refresh_token='));
  return header ? header.split(';')[0] : null;
}

async function closeDatabase() {
  await pool.end();
}

module.exports = {
  app,
  request,
  pool,
  outbox,
  PASSWORD,
  setupDatabase,
  resetDatabase,
  closeDatabase,
  createUser,
  createTask,
  refreshCookie
};
