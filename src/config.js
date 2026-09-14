'use strict';

const path = require('path');

const rootDir = path.resolve(__dirname, '..');

module.exports = {
  port: Number(process.env.PORT) || 3000,
  rootDir,
  publicDir: path.join(rootDir, 'public'),
  viewsDir: path.join(__dirname, 'views'),
  uploadsDir: path.join(rootDir, 'uploads'),
  dataFile: path.join(rootDir, 'data', 'tasks.json'),
  upload: {
    maxFileSize: 10 * 1024 * 1024, // 10 МБ на файл
    maxFiles: 5                    // файлов за одну отправку формы
  }
};
