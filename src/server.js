'use strict';

const app = require('./app');
const { port } = require('./config');

app.listen(port, () => {
  console.log(`Сервер запущен: http://localhost:${port}`);
});
