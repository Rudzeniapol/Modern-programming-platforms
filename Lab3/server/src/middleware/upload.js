'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

const { uploadsDir, upload: uploadConfig } = require('../config');

fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, uploadsDir);
  },
  // Имя на диске генерируем сами: исходное имя пользователя на файловую систему
  // не попадает, поэтому path traversal и коллизии имён исключены.
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).slice(0, 16).replace(/[^\w.]/g, '');
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  // Без этого имена файлов с кириллицей приходят в latin1 и превращаются в «кракозябры».
  defParamCharset: 'utf8',
  limits: {
    fileSize: uploadConfig.maxFileSize,
    files: uploadConfig.maxFiles
  }
});

/**
 * Принимает файлы из поля multipart-формы `attachments`.
 * Запросы с Content-Type: application/json multer пропускает не трогая,
 * поэтому один и тот же маршрут принимает и JSON, и multipart/form-data.
 */
const uploadAttachments = upload.array(uploadConfig.fieldName, uploadConfig.maxFiles);

/** Удаляет уже сохранённые файлы, если запрос в итоге отклонён валидацией. */
async function discardUploads(files = []) {
  await Promise.all(
    files.map((file) => fs.promises.unlink(file.path).catch(() => undefined))
  );
}

module.exports = { uploadAttachments, discardUploads };
