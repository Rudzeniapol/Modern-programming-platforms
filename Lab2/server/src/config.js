'use strict';

const path = require('path');

const rootDir = path.resolve(__dirname, '..');

// Всё, что зависит от окружения, собрано в одном месте:
// в Docker значения приходят из docker-compose.yml, локально — из defaults.
module.exports = {
  port: Number(process.env.PORT) || 3000,
  rootDir,
  uploadsDir: process.env.UPLOADS_DIR || path.join(rootDir, 'uploads'),
  // Пустая строка = CORS выключен (клиент и API за одним origin через nginx).
  corsOrigin: process.env.CORS_ORIGIN || '',
  db: {
    connectionString:
      process.env.DATABASE_URL || 'postgres://tasks:tasks@localhost:5432/tasks',
    // Контейнер API стартует раньше, чем Postgres готов принимать соединения.
    connectRetries: Number(process.env.DB_CONNECT_RETRIES) || 30,
    connectRetryDelayMs: Number(process.env.DB_CONNECT_RETRY_DELAY_MS) || 1000
  },
  upload: {
    maxFileSize: 10 * 1024 * 1024, // 10 МБ на файл
    maxFiles: 5,                   // файлов за один запрос
    fieldName: 'attachments'
  },
  jsonBodyLimit: '256kb'
};
