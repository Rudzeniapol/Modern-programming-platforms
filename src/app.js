'use strict';

const express = require('express');

const config = require('./config');
const tasksRouter = require('./routes/tasks');
const { notFound, errorHandler } = require('./middleware/errors');
const { STATUSES, statusLabel } = require('./lib/statuses');
const format = require('./lib/format');

const app = express();

// EJS рендерит HTML на сервере: клиент получает готовую разметку.
app.set('view engine', 'ejs');
app.set('views', config.viewsDir);

// Разбор данных обычных HTML-форм (application/x-www-form-urlencoded).
// Формы с файлами (multipart/form-data) разбирает multer в роутере.
app.use(express.urlencoded({ extended: false }));
app.use(express.static(config.publicDir));

// Хелперы и константы, доступные во всех шаблонах.
app.locals.STATUSES = STATUSES;
app.locals.statusLabel = statusLabel;
app.locals.maxFileSize = config.upload.maxFileSize;
app.locals.maxFiles = config.upload.maxFiles;
Object.assign(app.locals, format);

app.get('/', (req, res) => res.redirect('/tasks'));
app.use('/tasks', tasksRouter);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
