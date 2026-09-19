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
  // Имя на диске генерируем сами: исходное имя пользователя на файловую
  // систему не попадает, значит path traversal и коллизии исключены.
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

// Одно и то же поле формы <input type="file" name="attachments" multiple>
const uploadAttachments = upload.array('attachments', uploadConfig.maxFiles);

module.exports = { uploadAttachments };
