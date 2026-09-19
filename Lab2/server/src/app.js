'use strict';

const express = require('express');

const config = require('./config');
const apiRouter = require('./routes');
const { cors } = require('./middleware/cors');
const { notFound, errorHandler } = require('./middleware/errors');

const app = express();

app.disable('x-powered-by');

app.use(cors);
// JSON-тело запросов. multipart/form-data разбирает multer в маршрутах —
// этот парсер такие запросы пропускает не трогая.
app.use(express.json({ limit: config.jsonBodyLimit }));

app.use('/api', apiRouter);

// Сервер отдаёт только API: любой другой путь — 404 в том же JSON-формате.
app.use(notFound);
app.use(errorHandler);

module.exports = app;
