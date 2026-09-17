# Разбор проекта: структура, код и принцип работы
### Менеджер задач на Node.js + Express + EJS (лабораторная №1)

**Как читать этот файл.** Здесь разобрано, *что именно делает каждый файл и каждый кусок кода* и *как запрос проходит через приложение*. Общая теория (что такое SSR, event loop, middleware, PRG, XSS) вынесена в **`THEORY.md`** — здесь она не повторяется, а привязывается к конкретным строкам.

Порядок чтения перед защитой: сначала §1–§3 (карта и общая схема), потом §4 (разбор кода), потом §7 (сквозные сценарии — по ним удобно рассказывать).

---

## 1. Карта проекта

```
SPP_7_Sem/
│
├── package.json          зависимости, команды npm start / npm run dev
├── package-lock.json     точные версии всего дерева зависимостей (коммитится)
├── node_modules/         установленные пакеты (в git не хранится)
├── .gitignore            исключает node_modules, uploads/*, data/*.json
├── README.md             краткое описание для пользователя
├── THEORY.md             теория к защите
├── CODE_GUIDE.md         этот файл
│
├── data/
│   └── tasks.json        «база данных»: массив задач в JSON
│
├── uploads/
│   ├── .gitkeep          чтобы пустая папка попала в git
│   └── <uuid>.jpg        загруженные файлы под сгенерированными именами
│
├── public/               статика, раздаётся как есть (express.static)
│   └── css/style.css     единственный CSS-файл
│
└── src/
    ├── server.js             точка входа: поднимает HTTP-сервер
    ├── app.js                сборка Express-приложения
    ├── config.js             все пути и лимиты в одном месте
    │
    ├── routes/
    │   └── tasks.js          все маршруты /tasks  ← «контроллер»
    │
    ├── store/
    │   └── taskStore.js      чтение/запись JSON, CRUD, фильтрация  ← «репозиторий»
    │
    ├── lib/                  чистые функции, ничего не знают про HTTP
    │   ├── statuses.js       справочник статусов
    │   ├── validation.js     проверка данных формы
    │   └── format.js         форматирование дат, размеров, «просрочено»
    │
    ├── middleware/
    │   ├── upload.js         multer: приём файлов
    │   └── errors.js         404 и глобальный обработчик ошибок
    │
    └── views/                EJS-шаблоны ← «представления»
        ├── error.ejs
        ├── tasks/
        │   ├── index.ejs     список + фильтры + форма создания
        │   └── edit.ejs      редактирование задачи и вложений
        └── partials/
            ├── head.ejs      начало HTML + шапка
            ├── foot.ejs      подвал + закрытие HTML
            ├── notice.ejs    зелёная плашка «Задача добавлена»
            └── task-fields.ejs  общие поля формы (переиспользуются)
```

### Соответствие слоёв ASP.NET MVC

| Слой | Здесь | В ASP.NET |
|---|---|---|
| Точка входа | `src/server.js` | `Program.cs` |
| Конфигурация приложения | `src/app.js` | `Startup.cs` / `builder` |
| Настройки | `src/config.js` | `appsettings.json` + `IOptions<T>` |
| Контроллер | `src/routes/tasks.js` | `TasksController` |
| Репозиторий | `src/store/taskStore.js` | `ITaskRepository` / `DbContext` |
| Представления | `src/views/**.ejs` | `/Views/**.cshtml` |
| Частичные представления | `src/views/partials/` | `_Partial.cshtml` |
| Middleware | `src/middleware/` | `app.Use(...)` / фильтры |
| Хелперы | `src/lib/` | статические классы-хелперы |

---

## 2. Как работает приложение — общая схема

### 2.1. Что происходит при старте

```
npm start
   │
   ├─ node src/server.js
   │     └─ require('./app')  →  исполняется src/app.js
   │            ├─ require Express, роутер, middleware, хелперы
   │            ├─ app.set('view engine', 'ejs')   — подключён шаблонизатор
   │            ├─ app.use(...)                    — собран конвейер middleware
   │            ├─ app.locals.* = ...              — хелперы доступны всем шаблонам
   │            └─ module.exports = app            — приложение готово, но не запущено
   │
   └─ app.listen(3000)  →  открыт TCP-порт, сервер ждёт запросов
                           печатает «Сервер запущен: http://localhost:3000»
```

Заодно при `require('./middleware/upload')` выполняется `fs.mkdirSync(uploadsDir, {recursive:true})` — папка `uploads/` создаётся автоматически, если её нет.

### 2.2. Путь любого запроса

```
        Браузер
           │  HTTP-запрос
           ▼
   ┌───────────────────────────────────────────────┐
   │ express.urlencoded()   разбирает обычные формы│
   ├───────────────────────────────────────────────┤
   │ express.static(public) отдаёт /css/style.css  │──► если файл найден: ответ, конец
   ├───────────────────────────────────────────────┤
   │ GET '/'                редирект на /tasks     │
   ├───────────────────────────────────────────────┤
   │ router '/tasks'                               │
   │    ├─ multer (если маршрут с файлами)         │
   │    └─ asyncHandler(обработчик)                │
   │           ├─ parseFilter(req.query)           │
   │           ├─ validateTask(req.body)           │
   │           ├─ store.list / create / update ... │──► data/tasks.json
   │           └─ res.render(...) или res.redirect │
   ├───────────────────────────────────────────────┤
   │ notFound       ни один маршрут не совпал → 404│
   ├───────────────────────────────────────────────┤
   │ errorHandler   поймал исключение → 400/500    │
   └───────────────────────────────────────────────┘
           │  HTTP-ответ (готовый HTML или 302)
           ▼
        Браузер
```

**Два вида ответа, и только два:**
* `res.render(view, model)` — сервер строит HTML из шаблона и отдаёт его (код 200 или 400);
* `res.redirect(url)` — сервер отвечает кодом 302 и заголовком `Location`, браузер сам идёт по новому адресу (это делается после каждого успешного изменения данных — паттерн POST/Redirect/GET).

### 2.3. Направление зависимостей

```
routes/tasks.js ──► store/taskStore.js ──► data/tasks.json
      │                     │
      │                     └──► lib/statuses.js
      ├──► lib/validation.js ──► lib/statuses.js
      ├──► middleware/upload.js ──► config.js ──► uploads/
      └──► views/*.ejs  (через res.render)
                 └──► app.locals: lib/format.js, lib/statuses.js
```

Важно: **стрелки идут только вниз**. `taskStore` ничего не знает про `req`/`res` — его можно вызвать из тестов или из консольного скрипта. `lib/*` не знает вообще ни про что, кроме своих данных. Это и есть разделение ответственности.

---

## 3. Три сущности, вокруг которых всё построено

**Задача (task)** — объект в `data/tasks.json`:
```jsonc
{
  "id": "437e6625-a018-443b-8a6e-0f4903aec2b3",  // уникальный идентификатор (UUID)
  "title": "Выпуститься",                         // название, обязательное
  "description": "Дай бог",                       // описание, может быть пустым
  "status": "in_progress",                        // todo | in_progress | done
  "dueDate": "2029-10-12",                        // ожидаемая дата завершения или null
  "createdAt": "2026-09-14T15:09:27.428Z",        // когда создана
  "updatedAt": "2026-09-14T15:09:45.336Z",        // когда последний раз менялась
  "attachments": [ /* вложения */ ]
}
```

**Вложение (attachment)** — объект внутри задачи:
```jsonc
{
  "id": "575b8463-…",                 // идентификатор вложения (для ссылок скачивания/удаления)
  "originalName": "Back1.jpg",        // как файл назывался у пользователя — показываем и отдаём под ним
  "storedName": "9ec7072a-….jpg",     // как он лежит на диске в uploads/ — сгенерировано нами
  "size": 82852,                      // байты
  "mimeType": "image/jpeg",
  "uploadedAt": "2026-09-14T15:09:27.428Z"
}
```

**Фильтр (filter)** — то, что пользователь выбрал в интерфейсе; живёт **в URL**, не в памяти сервера:
```js
{ status: 'all' | 'todo' | 'in_progress' | 'done',
  sort:   'dueDate' | 'created' | 'title',
  query:  'строка поиска' }
```
Собирается из query-строки функцией `parseFilter()` и обратно превращается в `?status=…&sort=…&q=…` функцией `filterToQueryString()`. Благодаря этому фильтр переживает перезагрузку страницы и передаётся ссылкой.

---

## 4. Разбор кода по файлам

### 4.1. `package.json` — паспорт проекта

```jsonc
"main": "src/server.js",        // точка входа
"scripts": {
  "start": "node src/server.js",         // npm start
  "dev":   "node --watch src/server.js"  // npm run dev — авторестарт при правке файлов
},
"engines": { "node": ">=18" },  // требуемая версия Node
"dependencies": {
  "ejs": "^3.1.10",       // шаблонизатор
  "express": "^4.21.2",   // веб-фреймворк
  "multer": "^2.4.0"      // приём файлов (multipart/form-data)
}
```
Всего **три** зависимости — это плюс: каждая нужна и каждую можно объяснить.

---

### 4.2. `src/server.js` — точка входа (6 строк)

```js
const app = require('./app');
const { port } = require('./config');

app.listen(port, () => {
  console.log(`Сервер запущен: http://localhost:${port}`);
});
```

Единственная задача — открыть порт. **Почему это отдельно от `app.js`:** `app.js` экспортирует настроенное, но не запущенное приложение. Такой объект можно подключить в интеграционных тестах (например, через `supertest`) и дёргать маршруты без реального TCP-порта. Аналог: `WebApplicationFactory` в ASP.NET.

---

### 4.3. `src/app.js` — сборка приложения

Это самый важный файл для понимания порядка работы. Разбор построчно:

```js
const app = express();                       // создали приложение

app.set('view engine', 'ejs');               // 1. шаблонизатор по умолчанию
app.set('views', config.viewsDir);           //    где искать .ejs-файлы
```
После этих двух строк `res.render('tasks/index', …)` найдёт `src/views/tasks/index.ejs` — расширение дописывать не нужно.

```js
app.use(express.urlencoded({ extended: false }));   // 2. разбор обычных форм
```
Читает тело запроса с типом `application/x-www-form-urlencoded` и кладёт результат в `req.body`. Без этой строки `req.body` был бы `undefined`. `extended: false` — плоские объекты (`title=X&status=Y`), чего нам достаточно; `extended: true` умеет вложенные (`task[title]=X`). Формы с файлами эта строка **не** трогает — ими занимается multer.

```js
app.use(express.static(config.publicDir));          // 3. статика
```
Отдаёт файлы из `public/` как есть: запрос `/css/style.css` → файл `public/css/style.css`. Если файла нет — вызывает `next()` и запрос идёт дальше. Обратите внимание: **`uploads/` сюда не подключена** — загруженные файлы намеренно недоступны напрямую, только через маршрут с проверкой.

```js
app.locals.STATUSES = STATUSES;              // 4. глобальные данные для шаблонов
app.locals.statusLabel = statusLabel;
app.locals.maxFileSize = config.upload.maxFileSize;
app.locals.maxFiles = config.upload.maxFiles;
Object.assign(app.locals, format);           // formatDate, formatSize, isOverdue, isDueToday, …
```
Всё из `app.locals` доступно **в любом шаблоне** без передачи через `res.render`. Поэтому в `index.ejs` можно писать `<%= formatDate(task.dueDate) %>` — функция прилетела отсюда. `Object.assign(a, b)` копирует все свойства объекта `b` в `a` (аналог поэлементного присваивания).

```js
app.get('/', (req, res) => res.redirect('/tasks'));  // 5. корень → список задач
app.use('/tasks', tasksRouter);                      // 6. монтируем роутер по префиксу
app.use(notFound);                                   // 7. ничего не совпало → 404
app.use(errorHandler);                               // 8. что-то упало → 400/500
```

**Порядок критичен.** Если `notFound` поставить выше роутера — все страницы станут 404. Если `errorHandler` поставить не последним — он не поймает ошибки маршрутов.

---

### 4.4. `src/config.js` — настройки в одном месте

```js
const rootDir = path.resolve(__dirname, '..');   // __dirname = папка текущего файла (src/)

module.exports = {
  port: Number(process.env.PORT) || 3000,        // порт из переменной окружения или 3000
  publicDir:  path.join(rootDir, 'public'),
  viewsDir:   path.join(__dirname, 'views'),
  uploadsDir: path.join(rootDir, 'uploads'),
  dataFile:   path.join(rootDir, 'data', 'tasks.json'),
  upload: {
    maxFileSize: 10 * 1024 * 1024,  // 10 МБ на файл
    maxFiles: 5                     // файлов за одну отправку
  }
};
```

Зачем нужен отдельный файл: **все пути и лимиты собраны в одном месте**, ни один другой модуль не склеивает пути вручную. `path.join` собирает путь с правильным разделителем для ОС (`/` на Linux, `\` на Windows) — как `Path.Combine` в C#.

`process.env.PORT` — переменная окружения (аналог `Environment.GetEnvironmentVariable`). Поэтому работает `PORT=4000 npm start` — это стандарт для деплоя, хостинг сам назначает порт.

---

### 4.5. `src/lib/statuses.js` — справочник статусов

```js
const STATUSES = [
  { value: 'todo',        label: 'К выполнению' },
  { value: 'in_progress', label: 'В работе' },
  { value: 'done',        label: 'Выполнено' }
];
const STATUS_VALUES = STATUSES.map(s => s.value);   // ['todo','in_progress','done']
const DEFAULT_STATUS = 'todo';

function isValidStatus(value) { return STATUS_VALUES.includes(value); }
function statusLabel(value) { … }                   // 'done' → 'Выполнено'
```

**Главная идея файла — одно место истины.** Этот массив используется:
* в `<select>` формы (`partials/task-fields.ejs`);
* в кнопках быстрой смены статуса (`tasks/index.ejs`);
* во вкладках фильтра со счётчиками (`tasks/index.ejs`);
* в валидации (`lib/validation.js`);
* при проверке параметра `?status=` (`routes/tasks.js`);
* для подписи на бейдже задачи (`statusLabel`).

Добавить четвёртый статус = дописать одну строку здесь (плюс, по желанию, цвет в CSS). Это аналог `enum` + словаря `DisplayName` в C#, только на массиве объектов.

Разделение `value` / `label` — техническое значение отдельно от человеческого текста: в JSON и в URL хранится `in_progress`, пользователю показывается «В работе».

---

### 4.6. `src/lib/validation.js` — серверная проверка формы

```js
function validateTask(body = {}) {
  const values = {
    title:       String(body.title       ?? '').trim(),
    description: String(body.description ?? '').trim(),
    status:      String(body.status ?? DEFAULT_STATUS).trim(),
    dueDate:     String(body.dueDate     ?? '').trim()
  };
  const errors = {};
  …
  return { values, errors, valid: Object.keys(errors).length === 0 };
}
```

Разбор:
* `String(x ?? '')` — защита от `undefined`: если поля в форме не было (его могли удалить через DevTools или прислать запрос вручную), получим пустую строку, а не падение. `??` — оператор «если null/undefined, то…», такой же, как в C#.
* `.trim()` — нормализация: название из одних пробелов считается пустым.
* Возвращается **три** вещи: `values` (очищенные данные), `errors` (объект `{поле: 'текст ошибки'}`) и `valid` (флаг). Это ручной аналог `ModelState` из ASP.NET.

Правила:

| Поле | Проверка | Ошибка |
|---|---|---|
| `title` | непустое, ≤ 200 символов | «Введите название задачи» |
| `description` | ≤ 2000 символов | «Описание не длиннее 2000 символов» |
| `status` | входит в белый список | «Выберите корректный статус» + подстановка `todo` |
| `dueDate` | пусто **или** реальная дата `ГГГГ-ММ-ДД` | «Некорректная дата» |

Отдельно — проверка даты:
```js
function isRealDate(value) {
  if (!DATE_RE.test(value)) return false;              // формат ГГГГ-ММ-ДД
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
```
**Зачем так сложно:** регулярное выражение пропустит `2026-02-31` — формат правильный, а даты не существует. `Date.UTC` «перекрутит» её в 3 марта, и обратная сверка компонентов это поймает. Месяцы в JS нумеруются с нуля (`m - 1`) — классическая ловушка. `Date.UTC` вместо `new Date(y,m,d)` — чтобы результат не зависел от часового пояса сервера.

**Почему валидация обязательно на сервере:** атрибуты `required` и `maxlength` в HTML — это только удобство. Их обходит любой, кто откроет DevTools или отправит запрос через `curl`. Правило: *данные от клиента — всегда враждебные*.

---

### 4.7. `src/lib/format.js` — хелперы для шаблонов

Чистые функции, которые через `app.locals` попадают во все шаблоны.

| Функция | Что делает | Пример |
|---|---|---|
| `formatDate('2029-10-12')` | ISO-дата → русский формат | `12.10.2029` |
| `formatDateTime('2026-09-14T15:09:27.428Z')` | дата+время | `14.09.2026 18:09` |
| `formatSize(82852)` | байты → человеческий вид | `80.9 КБ` |
| `today()` | сегодняшняя дата строкой | `2026-09-17` |
| `isOverdue(task)` | просрочена ли задача | `true/false` |
| `isDueToday(task)` | срок сегодня | `true/false` |

```js
function isOverdue(task) {
  return Boolean(task.dueDate) && task.status !== 'done' && task.dueDate < today();
}
```
Три условия: срок задан **и** задача не выполнена **и** срок раньше сегодняшнего дня. Выполненная задача никогда не «просрочена» — это осознанное правило.

**Почему сравнение строк работает:** формат `ГГГГ-ММ-ДД` устроен так, что лексикографический порядок совпадает с хронологическим (`"2026-01-05" < "2026-02-01"`). Поэтому дату не нужно парсить ни для сравнения, ни для сортировки — это же свойство используется в `taskStore.list()`.

```js
function formatSize(bytes) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let value = Number(bytes) || 0, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
```
Делим на 1024, пока влезает, и не выходим за границы массива. Байты показываем целым числом, остальное — с одним знаком после запятой.

**Почему форматирование не в шаблоне:** шаблон должен только раскладывать данные по разметке. Логика «как показать дату» переиспользуется на двух страницах и тестируется отдельно, без запуска сервера.

---

### 4.8. `src/middleware/upload.js` — приём файлов (multer)

```js
fs.mkdirSync(uploadsDir, { recursive: true });   // папка создаётся при старте, если её нет
```
Единственное место, где используется **синхронная** файловая операция, и это нормально: она выполняется один раз при загрузке модуля, до того как сервер начал принимать запросы, — блокировать нечего.

```js
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),        // куда класть
  filename: (req, file, cb) => {                                // под каким именем
    const ext = path.extname(file.originalname).slice(0, 16).replace(/[^\w.]/g, '');
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});
```

Разбор функции `filename` — здесь три меры безопасности в трёх строках:
1. `path.extname('Back1.jpg')` → `'.jpg'` — берём **только расширение**, всё остальное имя отбрасываем;
2. `.slice(0, 16)` — обрезаем аномально длинное расширение;
3. `.replace(/[^\w.]/g, '')` — оставляем только буквы, цифры, `_` и точку; регулярка вычищает `/`, `\`, пробелы и прочее;
4. имя = `crypto.randomUUID()` + расширение — то есть **имя, пришедшее от пользователя, на файловую систему не попадает вообще**.

Это закрывает **path traversal**: файл с именем `../../src/app.js` не перезапишет код приложения. Заодно исчезают коллизии — два файла `отчёт.docx` от разных пользователей не затрут друг друга.

`cb(null, значение)` — стиль колбэков Node: первый аргумент — ошибка (`null`, если всё хорошо), второй — результат. Аналог `Action<Exception, T>`.

```js
const upload = multer({
  storage,
  defParamCharset: 'utf8',                       // имена файлов с кириллицей
  limits: { fileSize: 10 * 1024 * 1024, files: 5 }   // 10 МБ, 5 файлов
});
const uploadAttachments = upload.array('attachments', 5);
```
* `defParamCharset: 'utf8'` — без него имя `отчёт.docx` придёт в кодировке latin1 и превратится в «кракозябры» (в спецификации multipart кодировка имени не задана жёстко, поэтому её приходится указывать явно).
* `limits` — превышение прервёт загрузку и выбросит `MulterError`, который поймает `errorHandler`. Без лимитов любой желающий заливает гигабайт и кладёт диск.
* `upload.array('attachments', 5)` — ждём поле формы `<input type="file" name="attachments" multiple>` и до 5 файлов. Результат окажется в `req.files` (массив), текстовые поля той же формы — в `req.body`.

Другие варианты API multer: `upload.single('file')` → `req.file`; `upload.fields([...])` — несколько разных полей; `upload.none()` — форма без файлов.

**Ключевой момент для понимания потока:** multer — это middleware, он отрабатывает **до** вашего обработчика и сохраняет файлы на диск **сразу**. Поэтому если дальше валидация не прошла, файлы уже лежат в `uploads/` и их нужно удалить вручную (см. `discardFiles` в роутере).

---

### 4.9. `src/middleware/errors.js` — 404 и глобальный обработчик

```js
function notFound(req, res) {
  res.status(404).render('error', {
    title: 'Страница не найдена',
    message: `Страница ${req.originalUrl} не найдена.`
  });
}
```
Обычный middleware, зарегистрированный **последним среди «нормальных»**. Если запрос дошёл до него — значит, ни один маршрут выше не совпал. Сюда же приходят вызовы `next()` из обработчиков, когда задача с таким `id` не найдена.

```js
function errorHandler(error, req, res, next) {   // ЧЕТЫРЕ аргумента — это и делает его обработчиком ошибок
  if (error instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE:  `Файл слишком большой. Максимум — ${formatSize(maxFileSize)}.`,
      LIMIT_FILE_COUNT: `За одну отправку можно приложить не более ${maxFiles} файлов.`
    };
    return res.status(400).render('error', { title: 'Файл не загружен', message: … });
  }
  console.error(error);
  return res.status(error.status || 500).render('error', {
    title: 'Ошибка сервера',
    message: error.status === 404 ? error.message : 'Что-то пошло не так. Попробуйте повторить действие.'
  });
}
```

Три вещи, которые стоит назвать:
1. **Express отличает обработчик ошибок по числу параметров** (`fn.length === 4`). Это особенность фреймворка, а не JS.
2. **Ошибки multer переводятся на человеческий язык** и получают код 400 (ошибка клиента), а не 500. Коды `LIMIT_FILE_SIZE` / `LIMIT_FILE_COUNT` — из документации multer.
3. **Текст настоящей ошибки пользователю не показывается** — только в лог (`console.error`). Показывать стек трассировки наружу — утечка информации об устройстве сервера.

---

### 4.10. `src/store/taskStore.js` — слой доступа к данным

Самый содержательный файл. Разбираем по частям.

#### Очередь операций — «асинхронный мьютекс»

```js
let queue = Promise.resolve();

function serialize(operation) {
  const result = queue.then(operation, operation);      // ждём предыдущую, потом выполняем свою
  queue = result.then(() => undefined, () => undefined); // хвост очереди не «отравится» ошибкой
  return result;
}
```

**Зачем.** Node однопоточный, но между `await` в один обработчик может вклиниться другой:
```
Запрос A: прочитал файл [задача1] ──────────┐
Запрос B:        прочитал файл [задача1] ───┤  оба видят одно и то же
Запрос A: записал [задача1, новаяA] ────────┘
Запрос B: записал [задача1, новаяB]   ← затёр результат A, новаяA потеряна
```
`serialize` выстраивает операции в цепочку: каждая новая подцепляется к концу и стартует только после завершения предыдущей. Функциональный эквивалент `SemaphoreSlim(1,1)` или `lock` в C#.

Две тонкости:
* `queue.then(operation, operation)` — два одинаковых аргумента: операция запустится **и** после успеха предыдущей, **и** после её ошибки. Иначе одна упавшая операция навсегда заблокировала бы очередь.
* `queue = result.then(() => undefined, () => undefined)` — хвост очереди «обнуляется», чтобы отклонённый промис не всплыл как необработанная ошибка и не уронил процесс.

**Честное ограничение:** это работает только внутри одного процесса. Два запущенных экземпляра приложения снова начнут затирать файл — настоящее решение здесь СУБД.

#### Чтение и атомарная запись

```js
async function readAll() {
  try {
    const raw = await fs.readFile(dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];   // подстраховка от повреждённого файла
  } catch (error) {
    if (error.code === 'ENOENT') return [];       // файла ещё нет — это не ошибка, просто пусто
    throw error;
  }
}

async function writeAll(tasks) {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  const tmp = `${dataFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(tasks, null, 2), 'utf8');
  await fs.rename(tmp, dataFile);     // атомарная замена
}
```

* `ENOENT` = «Error NO ENTry», файл не найден. При первом запуске `data/tasks.json` не существует — возвращаем пустой массив вместо падения.
* `JSON.stringify(tasks, null, 2)` — третий аргумент даёт отступ в 2 пробела, файл остаётся читаемым человеком (удобно показать на защите).
* **Запись в `.tmp` + `rename`** — ключевой приём. Если писать прямо в `tasks.json` и процесс убить на середине, файл останется битым и приложение больше не запустится. `rename` внутри одной файловой системы — атомарная операция: на диске всегда либо целый старый файл, либо целый новый.

#### Преобразование файла в метаданные

```js
function toAttachment(file) {
  return {
    id: crypto.randomUUID(),
    originalName: file.originalname,   // от пользователя — только для показа и скачивания
    storedName: file.filename,         // сгенерированное имя на диске
    size: file.size,
    mimeType: file.mimetype,
    uploadedAt: new Date().toISOString()
  };
}
```
Объект multer'а превращается в компактную запись для JSON. Здесь и происходит **разделение двух имён файла** — то самое, что обеспечивает безопасность.

#### Методы репозитория

| Метод | Что делает |
|---|---|
| `list({status, query, sort})` | читает всё, фильтрует по статусу, ищет по тексту, сортирует |
| `counts()` | считает количество задач по каждому статусу — для счётчиков на вкладках |
| `getById(id)` | одна задача или `null` |
| `create(data, files)` | создаёт задачу с `id`, метками времени и вложениями |
| `update(id, data, files)` | частичное обновление + добавление новых файлов |
| `remove(id)` | удаляет задачу **и её файлы с диска** |
| `removeAttachment(taskId, attachmentId)` | удаляет одно вложение и его файл |

Фильтрация и поиск:
```js
const filtered = tasks.filter((task) => {
  if (status !== 'all' && task.status !== status) return false;
  if (!needle) return true;
  return task.title.toLowerCase().includes(needle)
      || (task.description || '').toLowerCase().includes(needle);
});
```
Поиск регистронезависимый (обе стороны в нижний регистр), идёт по названию **и** описанию. `(task.description || '')` — защита, если описания нет.

Сортировка:
```js
const comparators = {
  created: (a, b) => b.createdAt.localeCompare(a.createdAt),        // новые сверху
  title:   (a, b) => a.title.localeCompare(b.title, 'ru'),          // по алфавиту
  dueDate: (a, b) => {
    if (!a.dueDate && !b.dueDate) return byCreated(a, b);
    if (!a.dueDate) return 1;    // задачи без срока — в конец
    if (!b.dueDate) return -1;
    return a.dueDate.localeCompare(b.dueDate) || byCreated(a, b);   // при равных сроках — по дате создания
  }
};
return filtered.sort(comparators[sort] || comparators.dueDate);
```
* Компаратор возвращает отрицательное/0/положительное — как `IComparer<T>.Compare` в C#.
* `localeCompare(b, 'ru')` — корректное сравнение кириллицы; обычный `<` сравнивал бы коды символов и дал бы неправильный порядок для русских букв.
* `a.dueDate.localeCompare(b.dueDate) || byCreated(a, b)` — приём «вторичная сортировка»: если первый компаратор вернул `0` (равные даты), срабатывает второй, потому что `0` в JS ложно.

Счётчики:
```js
async counts() {
  const tasks = await serialize(readAll);
  return tasks.reduce((acc, task) => {
    acc.all += 1;
    acc[task.status] = (acc[task.status] || 0) + 1;
    return acc;
  }, { all: 0 });
}
```
`reduce` = `Aggregate` из LINQ. Результат вида `{ all: 5, todo: 2, in_progress: 1, done: 2 }`. **Важная деталь:** счётчики считаются по **всем** задачам и не зависят от строки поиска — вкладки показывают, сколько задач каждого статуса есть вообще.

Удаление:
```js
async remove(id) {
  return serialize(async () => {
    const tasks = await readAll();
    const index = tasks.findIndex((task) => task.id === id);
    if (index === -1) return null;                 // нет такой — маршрут превратит это в 404
    const [removed] = tasks.splice(index, 1);      // вырезаем из массива
    await writeAll(tasks);                         // сначала фиксируем JSON…
    await removeFiles(removed.attachments);        // …потом чистим диск
    return removed;
  });
}
```
Порядок важен: сначала сохраняем JSON, потом удаляем файлы. Если упасть между этими шагами, останется «файл-сирота» на диске (безобидно), а не ссылка в JSON на несуществующий файл (сломанная страница).

```js
async function removeFiles(attachments = []) {
  await Promise.all(attachments.map(async (attachment) => {
    try { await fs.unlink(path.join(uploadsDir, attachment.storedName)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }   // «уже удалён» — не ошибка
  }));
}
```
`Promise.all` = `Task.WhenAll` — удаляем файлы параллельно. Отсутствующий файл игнорируем: цель «файла нет» уже достигнута (идемпотентность).

---

### 4.11. `src/routes/tasks.js` — контроллер

#### Обёртка для async-обработчиков

```js
const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);
```
**Зачем нужна.** Express 4 не умеет ловить отклонённые промисы: если внутри `async (req, res) => {…}` выбросить исключение, фреймворк об этом не узнает — запрос просто зависнет, пока браузер не отвалится по таймауту. Обёртка перехватывает отклонение и передаёт его в `next(error)`, откуда оно попадает в `errorHandler`. В Express 5 это уже встроено.

#### Работа с фильтром

```js
function parseFilter(query = {}) {
  const status = STATUS_VALUES.includes(query.status) ? query.status : 'all';
  const sort   = SORTS.includes(query.sort) ? query.sort : 'dueDate';
  return { status, sort, query: String(query.q ?? '').trim() };
}
```
**Белый список (whitelist).** Значение из URL не берётся напрямую: если пришло `?status=хакер`, подставится `all`. Это защита от подстановки произвольных значений в дальнейшую логику — правильный подход, в отличие от чёрного списка («запретить вот эти значения»).

```js
function filterToQueryString(filter, extra = {}) {
  const params = new URLSearchParams();
  if (filter.status !== 'all')     params.set('status', filter.status);
  if (filter.sort !== 'dueDate')   params.set('sort', filter.sort);
  if (filter.query)                params.set('q', filter.query);
  for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
```
Обратная операция: фильтр → строка `?status=done&q=отчёт`. Значения по умолчанию **не пишутся** — URL остаётся коротким (`/tasks` вместо `/tasks?status=all&sort=dueDate&q=`). `URLSearchParams` сам выполняет URL-кодирование, поэтому поиск по строке с пробелами и кириллицей не ломает ссылку. Аргумент `extra` используется для `notice=created`.

Именно эта строка подставляется в `action` всех форм и во все редиректы — **благодаря ей после любого действия пользователь остаётся в той же выборке**, а не «вылетает» на общий список.

#### Общий рендер списка

```js
async function renderIndex(res, filter, { form, errors = {}, notice = null, statusCode = 200 }) {
  const [tasks, counts] = await Promise.all([store.list(filter), store.counts()]);
  res.status(statusCode).render('tasks/index', {
    title: 'Список задач', tasks, counts, filter,
    filterQuery: filterToQueryString(filter), form, errors, notice
  });
}
```
Используется в двух местах — при обычном показе списка и при ошибке валидации (тогда `statusCode: 400` и заполненные `errors`). Вынесено в функцию, чтобы не дублировать сбор модели. `Promise.all` запускает два запроса к хранилищу параллельно.

Объект, который уходит в шаблон, — это **модель представления (ViewModel)**: `tasks`, `counts`, `filter`, `filterQuery`, `form`, `errors`, `notice`.

#### Маршруты

| Метод | Путь | Что делает |
|---|---|---|
| `GET` | `/tasks` | список: `parseFilter` → `renderIndex` |
| `POST` | `/tasks` | создание: multer → валидация → `store.create` → редирект |
| `GET` | `/tasks/:id/edit` | форма редактирования |
| `POST` | `/tasks/:id` | сохранение + добавление файлов → редирект |
| `POST` | `/tasks/:id/status` | быстрая смена статуса → редирект |
| `POST` | `/tasks/:id/delete` | удаление задачи с файлами → редирект |
| `GET` | `/tasks/:taskId/attachments/:attachmentId` | скачивание файла |
| `POST` | `/tasks/:taskId/attachments/:attachmentId/delete` | удаление вложения → редирект |

`:id` — **параметр маршрута**, доступен как `req.params.id` (аналог `[FromRoute]`).

Создание задачи целиком:
```js
router.post('/', uploadAttachments, asyncHandler(async (req, res) => {
  const filter = parseFilter(req.query);
  const { values, errors, valid } = validateTask(req.body);

  if (!valid) {
    await discardFiles(req.files);                                   // убрать уже сохранённые файлы
    await renderIndex(res, filter, { form: values, errors, statusCode: 400 });
    return;
  }

  await store.create(values, req.files);
  res.redirect(`/tasks${filterToQueryString(filter, { notice: 'created' })}`);
}));
```
Обратите внимание на **два middleware подряд**: сначала `uploadAttachments` (multer разбирает multipart), потом обработчик. Именно поэтому в обработчике уже доступны `req.body` и `req.files`.

```js
async function discardFiles(files = []) {
  await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => undefined)));
}
```
Уборка «мусора»: multer сохранил файлы на диск ещё до валидации, и если форма не прошла — их надо удалить, иначе `uploads/` засорится файлами несуществующих задач. `.catch(() => undefined)` — ошибка удаления не должна ломать показ формы с ошибками.

Быстрая смена статуса:
```js
router.post('/:id/status', asyncHandler(async (req, res, next) => {
  const status = String(req.body.status ?? '');
  if (!STATUS_VALUES.includes(status)) {
    const error = new Error('Некорректный статус');
    error.status = 400;
    throw error;                       // улетит в errorHandler через asyncHandler
  }
  const updated = await store.update(req.params.id, { status });
  if (!updated) return next();         // нет задачи → провалиться в notFound → 404
  return res.redirect(`/tasks${filterToQueryString(parseFilter(req.query), { notice: 'status' })}`);
}));
```
Здесь видно оба способа «выйти из обработчика ненормально»:
* `throw` — ошибка, попадает в `errorHandler`;
* `next()` без аргументов — «я не обработал, передай дальше», запрос доходит до `notFound` и получает 404.

Скачивание вложения:
```js
router.get('/:taskId/attachments/:attachmentId', asyncHandler(async (req, res, next) => {
  const task = await store.getById(req.params.taskId);
  if (!task) return next();
  const attachment = task.attachments.find((item) => item.id === req.params.attachmentId);
  if (!attachment) return next();
  return res.download(path.join(uploadsDir, attachment.storedName), attachment.originalName, (error) => {
    if (error && !res.headersSent) next(error);
  });
}));
```
Три момента:
1. **Проверка принадлежности**: сначала находим задачу, потом вложение внутри неё. Нельзя скачать чужой файл, подставив произвольный `id`, — и нельзя обратиться к файлу, которого нет в JSON.
2. Путь к файлу собирается из `uploadsDir` и **сгенерированного** `storedName` — пользовательская строка в путь не попадает.
3. `res.download(path, name)` = отправить файл + заголовок `Content-Disposition: attachment; filename="Back1.jpg"`, который говорит браузеру «скачай под этим именем», а не «покажи». Проверка `res.headersSent` нужна, потому что ошибка может случиться уже после начала передачи — тогда менять ответ поздно.

---

## 5. Шаблоны EJS — как строится разметка

Напоминание синтаксиса: `<%= x %>` — вывести **с экранированием HTML**; `<%- x %>` — вывести как есть; `<% код %>` — выполнить, ничего не выводя.

### 5.1. `partials/head.ejs` и `partials/foot.ejs` — «разрезанный layout»

EJS не имеет полноценных layout'ов (в отличие от `_Layout.cshtml`), поэтому общая обвязка разделена на две части:

```
head.ejs: <!DOCTYPE html> … <head> … <header> … <main class="container">
    ← сюда вставляется содержимое конкретной страницы →
foot.ejs: </main> <footer> … </body></html>
```

Каждая страница начинается с `<%- include('../partials/head', { title }) %>` и заканчивается `<%- include('../partials/foot') %>`. Второй аргумент `include` — данные для частичного шаблона (аналог модели у `PartialAsync`).

В `head.ejs` заодно подключается единственный CSS (`/css/style.css` — его отдаёт `express.static`) и favicon, встроенный прямо в атрибут как `data:`-URL с SVG — чтобы не заводить отдельный файл.

### 5.2. `partials/task-fields.ejs` — общие поля формы

Используется **дважды**: в форме создания (`index.ejs`) и в форме редактирования (`edit.ejs`). Содержит название, описание, статус, дату и поле файлов.

```html
<input id="<%= prefix %>-title" name="title" type="text" maxlength="200" required
       value="<%= form.title %>">
<% if (errors.title) { %><p class="field__error"><%= errors.title %></p><% } %>
```

Здесь три важные детали:
* **`name` против `id`.** Браузер отправляет на сервер только поля с атрибутом `name` — это имя, под которым значение попадёт в `req.body`. `id` нужен лишь для связи с `<label for="…">`.
* **`prefix`** (`'new'` или `'edit'`) передаётся при `include` и подставляется в `id`. Зачем: если на одной странице окажутся обе формы, `id` не должны совпасть, иначе клик по подписи будет фокусировать не то поле.
* **`value="<%= form.title %>"`** — форма всегда отрисовывается из объекта `form`. При ошибке валидации туда кладутся введённые пользователем данные, и он не заполняет всё заново.

Выпадающий список статусов строится из справочника:
```html
<% STATUSES.forEach((status) => { %>
  <option value="<%= status.value %>" <%= form.status === status.value ? 'selected' : '' %>>
    <%= status.label %>
  </option>
<% }); %>
```
`STATUSES` прилетел из `app.locals`. Атрибут `selected` проставляется тернарным оператором — так сервер «запоминает» текущий выбор.

Поле даты — `<input type="date">`: браузер сам показывает календарь и присылает значение строго в формате `ГГГГ-ММ-ДД`, который напрямую ложится в JSON. Никаких преобразований не нужно.

Поле файлов — `<input type="file" name="attachments" multiple>`; `multiple` разрешает выбрать несколько файлов сразу, а имя совпадает с тем, что ждёт `upload.array('attachments', 5)`.

### 5.3. `tasks/index.ejs` — главная страница

Состоит из трёх блоков.

**Блок 1. Форма создания.**
```html
<form class="task-form" action="/tasks<%= filterQuery %>" method="post"
      enctype="multipart/form-data">
```
* `action` включает `filterQuery` — текущий фильтр переносится в редирект, и после создания пользователь остаётся в своей выборке;
* `method="post"` — изменение данных;
* **`enctype="multipart/form-data"` обязателен**: без него браузер отправит только имя файла, а содержимое потеряется.

**Блок 2. Фильтры.** Вкладки — это обычные ссылки (`GET`), а не формы:
```html
<a class="tab <%= filter.status === 'all' ? 'tab--active' : '' %>" href="<%= buildLink({status:'all'}) %>">
  Все <span class="tab__count"><%= counts.all || 0 %></span>
</a>
```
Функция `buildLink()`, объявленная в начале шаблона, собирает ссылку, **сохраняя остальные параметры**: при клике на вкладку не теряются строка поиска и сортировка. Активная вкладка получает класс-модификатор.

Поиск и сортировка — форма `method="get"`:
```html
<form class="filters__form" action="/tasks" method="get">
  <input type="hidden" name="status" value="<%= filter.status %>">
  <input type="search" name="q" value="<%= filter.query %>">
  <select name="sort"> … </select>
```
GET выбран осознанно: параметры попадают в адресную строку, выборкой можно поделиться ссылкой, F5 безопасен, работает кнопка «Назад». Скрытое поле `status` нужно, чтобы поиск не сбросил выбранную вкладку.

**Блок 3. Список задач.** Для каждой задачи:
```html
<li class="task task--<%= task.status %> <%= isOverdue(task) ? 'task--overdue' : '' %>">
```
Статус и признак просрочки превращаются в CSS-классы — вся визуальная логика (цвет полосы, зачёркнутый заголовок у выполненных, красноватый фон у просроченных) остаётся в CSS, а шаблон только расставляет классы.

Быстрая смена статуса — самый изящный приём в работе:
```html
<form action="/tasks/<%= task.id %>/status<%= filterQuery %>" method="post">
  <% STATUSES.forEach((status) => { %>
    <button type="submit" name="status" value="<%= status.value %>"
            <%= task.status === status.value ? 'disabled' : '' %>><%= status.label %></button>
  <% }); %>
</form>
```
У кнопки `submit` тоже есть `name` и `value`, и браузер отправляет значение **именно нажатой** кнопки. Три кнопки в одной форме дают три разных POST-запроса — **без единой строчки JavaScript**. Текущий статус — `disabled`, нажать на него нельзя.

Удаление:
```html
<form action="/tasks/<%= task.id %>/delete<%= filterQuery %>" method="post"
      onsubmit="return confirm('Удалить задачу вместе с вложениями?');">
```
Это единственный JavaScript во всём приложении. Если его отключить — удаление просто произойдёт без подтверждения, функциональность не пострадает (это называется «прогрессивное улучшение»).

Пустой список обрабатывается осмысленно: «задач вообще нет» и «под фильтр ничего не подошло» — разные сообщения, различаются по `counts.all`.

### 5.4. `tasks/edit.ejs` — страница редактирования

Две панели: форма с теми же полями (`task-fields`) и отдельный список вложений с кнопками скачать/удалить. Ссылка «← К списку задач» и кнопка «Отмена» несут `filterQuery`, чтобы вернуть пользователя в ту же выборку.

Форма редактирования тоже `multipart/form-data`: через неё можно **добавить** новые файлы к существующей задаче (старые при этом сохраняются — см. `store.update`, где `task.attachments.push(...)`).

### 5.5. `partials/notice.ejs` — уведомления

```js
const NOTICES = { created: 'Задача добавлена.', saved: 'Изменения сохранены.', … };
const noticeText = notice && NOTICES[notice];
```
Маршрут кладёт в редирект `?notice=created`, страница переводит код в текст. Словарь на сервере, а не текст в URL, — чтобы через адресную строку нельзя было вывести на страницу произвольное сообщение (простейшая защита от фишинга). Атрибут `role="status"` сообщает скринридерам, что появился новый текст.

Это упрощённый аналог **flash-сообщений** (`TempData` в ASP.NET). «Взрослый» вариант — `express-session` + `connect-flash`, здесь сессии не подключались, чтобы не тянуть зависимость.

### 5.6. `error.ejs` — страница ошибки

Один шаблон на все случаи: 404, слишком большой файл, 500. Получает `title` и `message`, показывает кнопку возврата к списку.

### 5.7. `public/css/style.css` — оформление

182 строки обычного CSS, без препроцессоров и фреймворков. Что стоит знать:

* **CSS-переменные** в `:root` (`--primary`, `--danger`, `--done`…) — палитра задана один раз и используется как `var(--primary)`. Смена темы = правка нескольких строк.
* **Именование BEM**: `.task`, `.task__title` (элемент), `.task--done` (модификатор). Отсюда классы вида `task task--done task--overdue` в шаблоне.
* **Flexbox** для раскладки (`display: flex`, `gap`), `width: min(960px, 100% - 32px)` для контейнера.
* **Адаптивность**: `@media (max-width: 640px)` перестраивает блоки на узких экранах.
* **Тёмная тема**: `@media (prefers-color-scheme: dark)` переопределяет переменные, если в системе включена тёмная тема.

CSS отдаётся `express.static` как статический файл — сервер его не обрабатывает, просто отправляет содержимое.

### 5.8. Служебные файлы

* **`data/tasks.json`** — хранилище. Создаётся при первом сохранении; в `.gitignore`, потому что это данные, а не код.
* **`uploads/`** — загруженные файлы под UUID-именами. В git держится только `.gitkeep` (git не умеет хранить пустые папки).
* **`.gitignore`** — исключает `node_modules/` (восстанавливается из `package-lock.json`), `uploads/*`, `data/*.json`, логи.

---

## 6. Жизненный цикл прикреплённого файла

```
1. Пользователь выбирает Back1.jpg в <input type="file" name="attachments">
        │
2. Браузер отправляет POST с multipart/form-data: байты файла + имя "Back1.jpg"
        │
3. multer сохраняет его на диск под новым именем:
        uploads/9ec7072a-c723-4187-b7d9-2fefb6266094.jpg
        и кладёт описание в req.files[0]
        │
4. toAttachment() создаёт запись в JSON:
        { id, originalName: "Back1.jpg", storedName: "9ec7072a-….jpg", size, mimeType }
        │
5. Показ: <a href="/tasks/<taskId>/attachments/<attachmentId>">📎 Back1.jpg</a>
        │
6. Скачивание: маршрут проверяет задачу и вложение → res.download(uploads/9ec7072a-….jpg, "Back1.jpg")
        браузер получает Content-Disposition и сохраняет файл под исходным именем
        │
7. Удаление: запись убирается из JSON, файл — с диска (fs.unlink)
```

**Суть в одной фразе:** пользовательское имя живёт только в JSON и в заголовке ответа; на файловой системе — только сгенерированный UUID.

---

## 7. Сквозные сценарии (по ним удобно рассказывать на защите)

### 7.1. Открытие списка — `GET /tasks?status=todo&q=отчёт`

1. Запрос проходит `urlencoded` (тела нет — пропускает) и `static` (файла нет — `next()`).
2. Совпадает `router.get('/')` внутри роутера, смонтированного на `/tasks`.
3. `parseFilter(req.query)` → `{status:'todo', sort:'dueDate', query:'отчёт'}` — значения проверены по белому списку.
4. `renderIndex` параллельно запрашивает `store.list(filter)` и `store.counts()`.
5. `store.list` через `serialize` читает `tasks.json`, фильтрует по статусу и подстроке, сортирует по сроку.
6. `res.render('tasks/index', model)` — EJS собирает HTML: вкладки со счётчиками, форма, список `<li>`.
7. Ответ **200** с готовой разметкой. Браузер только отображает — никакого JS.

### 7.2. Создание задачи с файлом — `POST /tasks`

1. Браузер шлёт `multipart/form-data` с полями и байтами файла.
2. `express.urlencoded` пропускает (чужой тип), `static` не совпадает, входим в роутер.
3. **multer** разбирает тело, сохраняет файл в `uploads/<uuid>.jpg`, заполняет `req.body` и `req.files`.
4. `validateTask(req.body)`:
   * **ошибка** → `discardFiles(req.files)` удаляет уже сохранённый файл → `res.status(400).render('tasks/index', {form: values, errors})` — та же страница с подсветкой ошибок и сохранённым вводом;
   * **успех** → шаг 5.
5. `store.create` встаёт в очередь: читает JSON, добавляет задачу с `randomUUID()`, метками времени и метаданными файла, пишет во временный файл, делает `rename`.
6. `res.redirect('/tasks?notice=created')` — ответ **302**.
7. Браузер сам делает **GET** по адресу из `Location` → сценарий 7.1 → страница с новой задачей и плашкой «Задача добавлена».
8. F5 теперь безопасен: последним в истории был GET, дубликат не создастся.

### 7.3. Смена статуса одной кнопкой — `POST /tasks/:id/status`

1. Нажата кнопка `<button name="status" value="done">`; браузер шлёт форму с единственным полем `status=done`.
2. `express.urlencoded` заполняет `req.body`. Multer здесь не участвует — файлов нет.
3. Обработчик проверяет `status` по белому списку (иначе — ошибка 400).
4. `store.update(id, {status})` — частичное обновление: меняется только статус и `updatedAt`.
5. Редирект на список с сохранённым фильтром + `notice=status`.

**Тонкость, которую любят спрашивать:** если фильтр стоит на «К выполнению», а задачу перевели в «Выполнено», она исчезнет из списка. Это ожидаемое поведение — фильтр применяется заново при новом GET.

### 7.4. Редактирование — `GET /tasks/:id/edit` → `POST /tasks/:id`

1. `GET`: `store.getById(id)`; если задачи нет — `next()` → `notFound` → **404**. Если есть — форма заполняется текущими значениями (`form` собирается из задачи).
2. `POST`: multer принимает новые файлы → валидация → `store.update(id, values, req.files)`.
3. В `store.update` новые файлы **добавляются** к существующим (`task.attachments.push(...)`), а не заменяют их.
4. Редирект обратно на страницу редактирования с `notice=saved`.

### 7.5. Скачивание файла — `GET /tasks/:taskId/attachments/:attachmentId`

1. Находим задачу → не нашли: `next()` → 404.
2. Находим вложение **внутри этой задачи** → не нашли: 404. Это и есть проверка прав доступа к файлу.
3. `res.download(uploads/<storedName>, originalName)` — файл уходит с заголовком `Content-Disposition`, браузер сохраняет его под исходным именем.

### 7.6. Удаление задачи — `POST /tasks/:id/delete`

1. `confirm()` в браузере (единственный клиентский JS) — можно отменить.
2. `store.remove(id)`: вырезаем задачу из массива → пишем JSON → удаляем все её файлы с диска.
3. Редирект на список с `notice=deleted`.

### 7.7. Ошибки

| Что сделал пользователь | Что происходит | Код |
|---|---|---|
| Открыл несуществующий URL | не совпал ни один маршрут → `notFound` | 404 |
| Открыл задачу с чужим `id` | `getById` вернул `null` → `next()` → `notFound` | 404 |
| Отправил пустое название | `validateTask` вернул ошибки → рендер формы с подсветкой | 400 |
| Приложил файл 50 МБ | multer бросил `LIMIT_FILE_SIZE` → `errorHandler` | 400 |
| Приложил 10 файлов | `LIMIT_FILE_COUNT` → `errorHandler` | 400 |
| Сервер упал на чтении JSON | исключение → `asyncHandler` → `next(err)` → `errorHandler`, стек в лог | 500 |

---

## 8. Основные понятия — с привязкой к коду

| Понятие | Что это | Где в проекте |
|---|---|---|
| **Маршрут (route)** | связка «метод + путь → обработчик» | `router.post('/:id/delete', …)` |
| **Параметр маршрута** | часть пути (`:id`), доступна как `req.params.id` | `/tasks/:id/edit` |
| **Query-строка** | параметры после `?`, доступны как `req.query` | `?status=done&q=отчёт` |
| **Middleware** | функция `(req, res, next)` в конвейере | `express.urlencoded`, multer, `notFound` |
| **Роутер** | группа маршрутов с общим префиксом | `app.use('/tasks', tasksRouter)` |
| **Шаблон (view)** | файл, превращаемый в HTML на сервере | `views/tasks/index.ejs` |
| **Частичный шаблон (partial)** | переиспользуемый кусок разметки | `partials/task-fields.ejs` |
| **Модель представления** | объект с данными для шаблона | второй аргумент `res.render` |
| **`app.locals`** | данные, доступные всем шаблонам | `STATUSES`, `formatDate` |
| **Статика** | файлы, отдаваемые как есть | `public/css/style.css` |
| **Репозиторий** | слой доступа к данным | `store/taskStore.js` |
| **Валидация** | проверка данных на сервере | `lib/validation.js` |
| **Белый список** | принимаем только известные значения | `parseFilter`, `isValidStatus` |
| **PRG** | POST → 302 → GET | `res.redirect` после каждого изменения |
| **Flash-сообщение** | одноразовое уведомление | `?notice=created` + `partials/notice.ejs` |
| **`multipart/form-data`** | формат тела формы с файлами | `enctype` в обеих формах |
| **Экранирование** | обезвреживание HTML в данных | `<%= %>` во всех шаблонах |
| **Path traversal** | попытка вылезти из папки через `../` | закрыт генерацией имени в `upload.js` |
| **Атомарная запись** | запись во временный файл + `rename` | `writeAll` |
| **Идемпотентность** | повтор не меняет результат | GET-фильтры, `unlink` с игнором `ENOENT` |

---

## 9. Где что менять (шпаргалка)

| Задача | Что править |
|---|---|
| Добавить статус (например, «Отменено») | одна строка в `src/lib/statuses.js`; по желанию — цвет в `style.css` |
| Добавить поле задачи (например, приоритет) | `lib/validation.js` (правило) → `partials/task-fields.ejs` (поле формы) → `store.create`/`update` (сохранение) → `tasks/index.ejs` (показ) |
| Изменить лимиты файлов | `src/config.js`, объект `upload` |
| Сменить порт | `PORT=4000 npm start` или `src/config.js` |
| Добавить сортировку | массив `SORTS` в `routes/tasks.js` + компаратор в `store.list` + `<option>` в `index.ejs` |
| Перейти на базу данных | переписать **только** `src/store/taskStore.js`, сохранив имена методов |
| Изменить оформление | `public/css/style.css` (переменные в `:root`) |
| Добавить новую страницу | новый `router.get(...)` + шаблон в `src/views/` |

---

## 10. Вопросы по коду, которые могут задать

**Почему `server.js` и `app.js` — разные файлы?**
`app.js` собирает приложение, но не запускает его. Это позволяет подключить приложение в тестах без открытия порта.

**Зачем `asyncHandler`?**
Express 4 не ловит исключения из `async`-функций — запрос зависнет. Обёртка превращает отклонённый промис в `next(error)`, и ошибка попадает в глобальный обработчик.

**Почему `errorHandler` с четырьмя параметрами?**
Так Express отличает обработчик ошибок от обычного middleware — по количеству аргументов функции.

**Что будет, если убрать `enctype="multipart/form-data"`?**
Файл не загрузится: браузер отправит только его имя текстом, содержимое потеряется, `req.files` будет пустым.

**Почему имя файла на диске не совпадает с тем, что выбрал пользователь?**
Безопасность: пользовательское имя может содержать `../` (выход из папки) или совпасть с чужим. На диск идёт UUID, оригинальное имя хранится в JSON и подставляется при скачивании.

**Почему `uploads/` не раздаётся через `express.static`?**
Иначе залитый `.html`- или `.svg`-файл открылся бы с домена приложения и мог бы выполнить скрипт с доступом к cookie (stored XSS). Доступ только через маршрут, который сначала проверяет, что вложение принадлежит существующей задаче.

**Зачем очередь `serialize`, если Node однопоточный?**
Однопоточность не спасает от чередования вокруг `await`: два запроса успевают прочитать один и тот же массив и записать по очереди, затирая друг друга. Очередь — асинхронный аналог `lock`.

**Почему запись идёт через `.tmp` и `rename`?**
Чтобы файл не остался «наполовину записанным» при падении процесса. `rename` в пределах одной ФС атомарен.

**Почему даты хранятся строками?**
Формат `ГГГГ-ММ-ДД` сортируется как строка в хронологическом порядке, принимается и отдаётся `<input type="date">` без преобразований и не зависит от часового пояса.

**Зачем `prefix` в `task-fields.ejs`?**
Чтобы `id` полей не конфликтовали, если на одной странице окажутся обе формы: получаются `new-title` и `edit-title`, и `<label for>` указывает на нужное поле.

**Что делает `filterQuery` в `action` формы?**
Переносит текущий фильтр в редирект, чтобы после действия пользователь остался в той же выборке, а не оказался на общем списке.

**Почему счётчики на вкладках не учитывают поиск?**
`store.counts()` считает все задачи по статусам. Вкладка отвечает на вопрос «сколько задач такого статуса есть вообще», а не «сколько найдено» — иначе счётчики прыгали бы при каждом вводе символа.

**Как удалить задачу, если HTML-формы не умеют DELETE?**
Через `POST /tasks/:id/delete`. Спецификация HTML разрешает формам только GET и POST; PUT/PATCH/DELETE доступны только из JavaScript.

**Что произойдёт при отключённом JavaScript?**
Всё будет работать, кроме двух диалогов подтверждения удаления. Приложение не зависит от клиентского JS — это и есть доказательство настоящего серверного рендеринга.
