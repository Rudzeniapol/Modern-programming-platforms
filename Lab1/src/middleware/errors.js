'use strict';

const multer = require('multer');

const { upload: uploadConfig } = require('../config');
const { formatSize } = require('../lib/format');

function notFound(req, res) {
  res.status(404).render('error', {
    title: 'Страница не найдена',
    message: `Страница ${req.originalUrl} не найдена.`
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(error, req, res, next) {
  if (error instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: `Файл слишком большой. Максимум — ${formatSize(uploadConfig.maxFileSize)}.`,
      LIMIT_FILE_COUNT: `За одну отправку можно приложить не более ${uploadConfig.maxFiles} файлов.`
    };
    return res.status(400).render('error', {
      title: 'Файл не загружен',
      message: messages[error.code] || `Ошибка загрузки файла: ${error.message}`
    });
  }

  console.error(error);
  return res.status(error.status || 500).render('error', {
    title: 'Ошибка сервера',
    message: error.status === 404 ? error.message : 'Что-то пошло не так. Попробуйте повторить действие.'
  });
}

module.exports = { notFound, errorHandler };
