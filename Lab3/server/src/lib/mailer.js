'use strict';

const nodemailer = require('nodemailer');

const { mail } = require('../config');
const { logger } = require('./logger');

// memory — письма не уходят в сеть, а складываются в outbox (для автотестов).
const outbox = [];

const transport =
  mail.transport === 'memory'
    ? nodemailer.createTransport({ jsonTransport: true })
    : nodemailer.createTransport({
        host: mail.host,
        port: mail.port,
        secure: mail.secure,
        auth: mail.user ? { user: mail.user, pass: mail.password } : undefined
      });

async function sendMail({ to, subject, text, html }) {
  const info = await transport.sendMail({ from: mail.from, to, subject, text, html });
  if (mail.transport === 'memory') outbox.push({ to, subject, text, html });
  logger.info({ event: 'mail.sent', to, subject, messageId: info.messageId }, 'Письмо отправлено');
  return info;
}

/**
 * Письмо отправляется «в фоне»: ответ на запрос не ждёт SMTP и не выдаёт
 * по времени ответа, существует ли адрес. Ошибка отправки попадает в журнал.
 */
function sendMailInBackground(message) {
  sendMail(message).catch((error) => {
    logger.error({ event: 'mail.failed', err: error, to: message.to, subject: message.subject }, 'Не удалось отправить письмо');
  });
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function passwordResetEmail({ name, link, ttlMinutes }) {
  return {
    subject: 'Восстановление доступа к менеджеру задач',
    text:
      `Здравствуйте, ${name}!\n\n` +
      `Кто-то (возможно, вы) запросил восстановление пароля. Чтобы задать новый пароль, откройте ссылку:\n${link}\n\n` +
      `Ссылка действует ${ttlMinutes} минут и сработает только один раз.\n` +
      'Если вы не запрашивали восстановление — просто проигнорируйте это письмо.',
    html:
      `<p>Здравствуйте, ${escapeHtml(name)}!</p>` +
      '<p>Кто-то (возможно, вы) запросил восстановление пароля. Чтобы задать новый пароль, перейдите по ссылке:</p>' +
      `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` +
      `<p>Ссылка действует ${ttlMinutes} минут и сработает только один раз.</p>` +
      '<p>Если вы не запрашивали восстановление — просто проигнорируйте это письмо.</p>'
  };
}

function accountLockedEmail({ name, ip, lockMinutes, resetUrl }) {
  return {
    subject: 'Вход в учётную запись временно заблокирован',
    text:
      `Здравствуйте, ${name}!\n\n` +
      `Зафиксировано несколько неудачных попыток входа в вашу учётную запись (последняя — с адреса ${ip}).\n` +
      `Вход заблокирован на ${lockMinutes} минут.\n\n` +
      `Если это были не вы, смените пароль: ${resetUrl}`,
    html:
      `<p>Здравствуйте, ${escapeHtml(name)}!</p>` +
      `<p>Зафиксировано несколько неудачных попыток входа в вашу учётную запись (последняя — с адреса ${escapeHtml(ip)}).</p>` +
      `<p>Вход заблокирован на ${lockMinutes} минут.</p>` +
      `<p>Если это были не вы, <a href="${escapeHtml(resetUrl)}">смените пароль</a>.</p>`
  };
}

module.exports = { sendMail, sendMailInBackground, passwordResetEmail, accountLockedEmail, outbox };
