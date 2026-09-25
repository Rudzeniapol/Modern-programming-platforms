'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

// Параметры scrypt (N=2^15, r=8, p=1) — рекомендация OWASP для хранения паролей.
// Они записываются в сам хеш, поэтому их можно усилить, не ломая старые пароли.
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

/** Формат: scrypt$N$r$p$соль$хеш (соль и хеш — base64url). */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64url');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64url'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: PARAMS.maxmem
  });
  // Сравнение за постоянное время: по времени ответа нельзя угадать совпавший префикс.
  return crypto.timingSafeEqual(key, expected);
}

// Хеш-пустышка: если пользователя нет, всё равно тратим время на проверку пароля,
// иначе по скорости ответа можно было бы узнать, какие email зарегистрированы.
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(crypto.randomBytes(16).toString('hex'));
  return dummyHashPromise;
}

/** Требования к паролю; возвращает текст ошибки или null. */
function checkPasswordPolicy(password) {
  if (typeof password !== 'string' || !password) return 'Введите пароль';
  if (password.length < PASSWORD_MIN) return `Пароль не короче ${PASSWORD_MIN} символов`;
  if (password.length > PASSWORD_MAX) return `Пароль не длиннее ${PASSWORD_MAX} символов`;
  if (!/\p{L}/u.test(password) || !/\d/.test(password)) return 'Пароль должен содержать буквы и цифры';
  return null;
}

module.exports = { hashPassword, verifyPassword, dummyHash, checkPasswordPolicy, PASSWORD_MIN, PASSWORD_MAX };
