'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const apiRouter = require('./routes');
const { cors } = require('./middleware/cors');
const { requestLogger } = require('./middleware/requestLogger');
const { notFound, errorHandler } = require('./middleware/errors');

const app = express();

app.disable('x-powered-by');
// За nginx req.ip должен быть адресом клиента, а не прокси: от него зависят
// лимиты запросов, защита от подбора пароля и журнал сессий.
app.set('trust proxy', config.trustProxy);

// Первым — журнал запросов: он назначает reqId, который увидят все остальные.
app.use(requestLogger);
app.use(cors);
// JSON-тело запросов. multipart/form-data разбирает multer в маршрутах —
// этот парсер такие запросы пропускает не трогая.
app.use(express.json({ limit: config.jsonBodyLimit }));
app.use(cookieParser());

app.use('/api', apiRouter);

// Сервер отдаёт только API: любой другой путь — 404 в том же формате problem+json.
app.use(notFound);
app.use(errorHandler);

module.exports = app;
