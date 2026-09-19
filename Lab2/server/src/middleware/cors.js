'use strict';

const { corsOrigin } = require('../config');

/**
 * Минимальный CORS для случая, когда клиент запускается отдельно (vite dev server
 * без прокси). В Docker клиент и API живут за одним nginx, и заголовки не нужны —
 * middleware включается только при заданном CORS_ORIGIN.
 */
function cors(req, res, next) {
  if (!corsOrigin) return next();

  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

module.exports = { cors };
