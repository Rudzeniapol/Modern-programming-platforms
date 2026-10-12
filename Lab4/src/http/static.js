'use strict';

const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

/**
 * Раздача статических файлов клиента без фреймворков.
 *  — путь нормализуется и обязан остаться внутри public/ (защита от path traversal: /../../etc/passwd);
 *  — ETag по размеру и времени изменения: повторный запрос неизменённого файла получает 304;
 *  — Cache-Control: no-cache — браузер всегда сверяется с сервером, поэтому после
 *    обновления приложения сразу получает новые файлы (имена файлов без хешей).
 */
function createStaticHandler(rootDir) {
  const root = path.resolve(rootDir);

  return function serveStatic(req, res, pathname) {
    let relative;
    try {
      relative = decodeURIComponent(pathname);
    } catch {
      return send(res, 400, 'Некорректный путь');
    }
    if (relative.endsWith('/')) relative += 'index.html';

    const filePath = path.resolve(root, `.${path.posix.normalize(relative)}`);
    if (!filePath.startsWith(root + path.sep)) return send(res, 403, 'Доступ запрещён');

    fs.stat(filePath, (error, stat) => {
      if (error || !stat.isFile()) return send(res, 404, 'Не найдено');

      const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');

      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304;
        return res.end();
      }

      res.setHeader('Content-Length', stat.size);
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(filePath).pipe(res);
    });
    return undefined;
  };
}

function send(res, status, text) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end(text);
}

module.exports = { createStaticHandler };
