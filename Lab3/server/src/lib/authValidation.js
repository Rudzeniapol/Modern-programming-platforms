'use strict';

const { HttpError } = require('./httpError');
const { checkPasswordPolicy } = require('./password');
const { ROLE_VALUES, isValidRole } = require('./roles');

const EMAIL_MAX = 254;
const NAME_MAX = 100;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Общая часть всех auth-эндпоинтов: тело — объект, в нём только известные
 * поля и только строки. Нарушение формы запроса — 400, а не 422:
 * такое тело собрал не пользователь, а сломанный клиент.
 */
function readBody(body, allowed, types = {}) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  if (!source) throw HttpError.badRequest('Тело запроса должно быть JSON-объектом');

  const unknown = Object.keys(source).filter((key) => !allowed.includes(key));
  if (unknown.length) throw HttpError.badRequest(`Неизвестные поля в запросе: ${unknown.join(', ')}`);

  for (const key of allowed) {
    const expected = types[key] || 'string';
    if (source[key] !== undefined && source[key] !== null && typeof source[key] !== expected) {
      throw HttpError.badRequest(`Поле ${key} должно иметь тип ${expected}`);
    }
  }
  return source;
}

const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

function emailError(email) {
  if (!email) return 'Введите email';
  if (email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return 'Некорректный email';
  return null;
}

function throwIfErrors(errors) {
  const fields = Object.fromEntries(Object.entries(errors).filter(([, message]) => message));
  if (Object.keys(fields).length) throw HttpError.unprocessable('Проверьте заполнение полей', fields);
}

function validateRegistration(body) {
  const source = readBody(body, ['email', 'name', 'password']);
  const email = normalizeEmail(source.email);
  const name = typeof source.name === 'string' ? source.name.trim() : '';

  throwIfErrors({
    email: emailError(email),
    name: !name ? 'Введите имя' : name.length > NAME_MAX ? `Имя не длиннее ${NAME_MAX} символов` : null,
    password: checkPasswordPolicy(source.password)
  });
  return { email, name, password: source.password };
}

// При входе пароль по политике не проверяем: иначе ответ подсказал бы,
// что пароль «точно не такой», — достаточно того, что поле не пустое.
function validateLogin(body) {
  const source = readBody(body, ['email', 'password']);
  const email = normalizeEmail(source.email);
  throwIfErrors({
    email: emailError(email),
    password: typeof source.password === 'string' && source.password ? null : 'Введите пароль'
  });
  return { email, password: source.password };
}

function validateForgotPassword(body) {
  const source = readBody(body, ['email']);
  const email = normalizeEmail(source.email);
  throwIfErrors({ email: emailError(email) });
  return { email };
}

function validateResetPassword(body) {
  const source = readBody(body, ['token', 'password']);
  if (typeof source.token !== 'string' || !source.token) {
    throw HttpError.badRequest('Не передан токен восстановления');
  }
  throwIfErrors({ password: checkPasswordPolicy(source.password) });
  return { token: source.token, password: source.password };
}

function validateChangePassword(body) {
  const source = readBody(body, ['currentPassword', 'newPassword']);
  throwIfErrors({
    currentPassword: typeof source.currentPassword === 'string' && source.currentPassword ? null : 'Введите текущий пароль',
    newPassword:
      checkPasswordPolicy(source.newPassword) ||
      (source.newPassword === source.currentPassword ? 'Новый пароль должен отличаться от текущего' : null)
  });
  return { currentPassword: source.currentPassword, newPassword: source.newPassword };
}

function validateUserPatch(body) {
  const source = readBody(body, ['role', 'isActive'], { isActive: 'boolean' });
  if (source.role === undefined && source.isActive === undefined) {
    throw HttpError.badRequest('Не передано ни одного поля для изменения. Допустимые: role, isActive');
  }
  throwIfErrors({
    role: source.role !== undefined && !isValidRole(source.role) ? `Допустимые роли: ${ROLE_VALUES.join(', ')}` : null
  });
  return { role: source.role, isActive: source.isActive };
}

module.exports = {
  normalizeEmail,
  validateRegistration,
  validateLogin,
  validateForgotPassword,
  validateResetPassword,
  validateChangePassword,
  validateUserPatch,
  NAME_MAX
};
