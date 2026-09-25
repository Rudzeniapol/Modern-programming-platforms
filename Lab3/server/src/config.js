'use strict';

const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const env = process.env.NODE_ENV || 'development';

const number = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value !== '' && value !== undefined ? parsed : fallback;
};

const DEV_JWT_SECRET = 'dev-only-secret-change-me-in-production-0123456789';

// Всё, что зависит от окружения, собрано в одном месте:
// в Docker значения приходят из docker-compose.yml, локально — из defaults.
const config = {
  env,
  isProduction: env === 'production',
  isTest: env === 'test',
  port: number(process.env.PORT, 3000),
  rootDir,
  uploadsDir: process.env.UPLOADS_DIR || path.join(rootDir, 'uploads'),
  // Пустая строка = CORS выключен (клиент и API за одним origin через nginx).
  corsOrigin: process.env.CORS_ORIGIN || '',
  // За nginx настоящий IP клиента приходит в X-Forwarded-For — он нужен
  // для ограничения частоты запросов и для журнала подключений.
  trustProxy: process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal',
  // Адрес SPA — из него собирается ссылка восстановления пароля в письме.
  appUrl: (process.env.APP_URL || 'http://localhost:8089').replace(/\/+$/, ''),
  db: {
    connectionString:
      process.env.DATABASE_URL || 'postgres://tasks:tasks@localhost:5432/tasks',
    // Контейнер API стартует раньше, чем Postgres готов принимать соединения.
    connectRetries: number(process.env.DB_CONNECT_RETRIES, 30),
    connectRetryDelayMs: number(process.env.DB_CONNECT_RETRY_DELAY_MS, 1000)
  },
  upload: {
    maxFileSize: 10 * 1024 * 1024, // 10 МБ на файл
    maxFiles: 5,                   // файлов за один запрос
    fieldName: 'attachments'
  },
  jsonBodyLimit: '256kb',

  log: {
    level: process.env.LOG_LEVEL || (env === 'test' ? 'silent' : 'info')
  },

  auth: {
    jwtSecret: process.env.JWT_SECRET || DEV_JWT_SECRET,
    usesDevSecret: !process.env.JWT_SECRET,
    jwtIssuer: 'spp-lab3-api',
    jwtAudience: 'spp-lab3-client',
    // Временные ключи: короткоживущий access-токен и долгоживущий refresh-токен,
    // который меняется при каждом обновлении (rotation).
    accessTokenTtlSec: number(process.env.ACCESS_TOKEN_TTL_SEC, 15 * 60),
    refreshTokenTtlSec: number(process.env.REFRESH_TOKEN_TTL_SEC, 7 * 24 * 60 * 60),
    // Параллельные запросы refresh из нескольких вкладок присылают один и тот же
    // старый токен — в этом окне повтор не считается кражей.
    refreshReuseGraceSec: number(process.env.REFRESH_REUSE_GRACE_SEC, 30),
    refreshCookieName: 'refresh_token',
    cookieSecure: process.env.COOKIE_SECURE === 'true',
    // Контроль активных подключений: при превышении закрывается самая старая сессия.
    maxSessionsPerUser: number(process.env.MAX_SESSIONS_PER_USER, 5),
    passwordResetTtlSec: number(process.env.PASSWORD_RESET_TTL_SEC, 30 * 60)
  },

  // Защита от подбора пароля.
  bruteForce: {
    windowSec: number(process.env.LOGIN_WINDOW_SEC, 15 * 60),
    maxFailuresPerAccount: number(process.env.LOGIN_MAX_FAILURES_PER_ACCOUNT, 5),
    maxFailuresPerIp: number(process.env.LOGIN_MAX_FAILURES_PER_IP, 20),
    lockoutSec: number(process.env.LOGIN_LOCKOUT_SEC, 15 * 60)
  },

  // Общие лимиты частоты запросов к публичным auth-эндпоинтам (на IP).
  rateLimit: {
    auth: { windowSec: 15 * 60, max: number(process.env.RATE_LIMIT_AUTH_MAX, 100) },
    passwordReset: { windowSec: 15 * 60, max: number(process.env.RATE_LIMIT_RESET_MAX, 5) }
  },

  seedAdmin: {
    email: process.env.ADMIN_EMAIL || 'admin@example.com',
    password: process.env.ADMIN_PASSWORD || 'Admin12345',
    name: process.env.ADMIN_NAME || 'Администратор'
  },

  mail: {
    // smtp — реальная отправка (в docker-compose это Mailpit),
    // memory — письма складываются в массив (используется в тестах).
    transport: process.env.MAIL_TRANSPORT || (env === 'test' ? 'memory' : 'smtp'),
    host: process.env.SMTP_HOST || 'localhost',
    port: number(process.env.SMTP_PORT, 1025),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    password: process.env.SMTP_PASSWORD || '',
    from: process.env.MAIL_FROM || 'Менеджер задач <no-reply@tasks.local>'
  }
};

if (config.isProduction && config.auth.usesDevSecret) {
  throw new Error('В production необходимо задать переменную окружения JWT_SECRET');
}

module.exports = config;
