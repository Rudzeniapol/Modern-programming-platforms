# Лабораторная работа №3 — Менеджер задач: доступ, безопасность, журналы, CI

Продолжение [лабораторной работы №2](../Lab2/README.md) (SPA на React + REST API на Express +
PostgreSQL). В этой работе приложение получило:

1. **модель доступа с тремя ролями** на основе **временных ключей** (короткоживущий JWT +
   одноразовый refresh-токен с ротацией);
2. **обработку ошибок и коды возврата по семантике HTTP** — единый формат
   `application/problem+json` (RFC 9457), обязательные заголовки `WWW-Authenticate`, `Allow`,
   `Retry-After`, `Location`;
3. **защиту от подбора пароля**, **контроль активных подключений** (список сессий, лимит,
   принудительное завершение) и **восстановление доступа через email**;
4. **структурированное логирование** — JSON-журнал в API (pino) и в nginx со сквозным `reqId`;
5. **автоматическую проверку кода** на каждое изменение — GitHub Actions (ESLint, автотесты
   на настоящем PostgreSQL, сборка SPA и Docker-образов, `npm audit`) и локальный pre-commit-хук.

## Запуск

```bash
cd Lab3
docker compose up --build
```

| Что | Адрес |
|-----|-------|
| SPA | <http://localhost:8089> |
| REST API (для curl/Postman) | <http://localhost:3003/api> |
| Почтовый ящик Mailpit (письма сброса пароля) | <http://localhost:8026> |

Первый администратор создаётся при первом запуске: **`admin@example.com` / `Admin12345`**
(переопределяется через `ADMIN_EMAIL` / `ADMIN_PASSWORD`). Остальные пользователи
регистрируются сами и получают роль «Пользователь»; роль меняет администратор в разделе
«Пользователи».

Все параметры — порты, время жизни ключей, лимиты — задаются в `.env` (шаблон `.env.example`).
**`JWT_SECRET` для реального развёртывания обязательно заменить** (`openssl rand -base64 48`):
в `docker-compose.yml` стоит демонстрационное значение, а без переменной API в production
вообще не стартует.

```bash
docker compose down      # остановить
docker compose down -v   # остановить и удалить тома (БД и файлы)
docker compose logs -f api   # журнал API (JSON)
```

### Запуск без Docker и автотесты

```bash
# PostgreSQL для тестов
docker run -d --rm --name lab3-db -e POSTGRES_USER=tasks -e POSTGRES_PASSWORD=tasks \
  -e POSTGRES_DB=tasks_test -p 55432:5432 postgres:16-alpine

cd Lab3/server
npm install
npm run lint
npm test            # 46 тестов: unit + интеграционные на реальной БД
                    # (адрес БД — переменная DATABASE_URL, по умолчанию localhost:55432)

cd ../client
npm install
npm run lint
npm run dev         # http://localhost:5173, /api проксируется на :3000
```

## 1. Модель доступа: роли и временные ключи

### Роли

| Право | Пользователь `user` | Менеджер `manager` | Администратор `admin` |
|-------|:---:|:---:|:---:|
| создавать задачи | ✔ | ✔ | ✔ |
| видеть / менять / удалять **свои** задачи | ✔ | ✔ | ✔ |
| видеть задачи **всех** пользователей | — | ✔ | ✔ |
| менять задачи всех пользователей (статус, поля, файлы) | — | ✔ | ✔ |
| удалять **чужие** задачи | — | — | ✔ |
| видеть список пользователей | — | ✔ | ✔ |
| менять роли, блокировать, снимать блокировку входа, завершать чужие сессии | — | — | ✔ |

Роль хранится в БД (`users.role`), набор прав выводится из роли в одном месте —
`server/src/lib/roles.js`. Права на задачи двухуровневые: `tasks:update:own` (только свои) и
`tasks:update:any` (любые). Проверка выполняется на сервере:

* нет права даже **прочитать** задачу → **404** (пользователь не должен узнавать о
  существовании чужих задач по разнице между 403 и 404);
* прочитать можно, а изменить/удалить нельзя → **403**;
* права проверяются **до** приёма файлов multer-ом — сервер не принимает мегабайты вложений
  от того, кому всё равно откажет.

Клиент использует список прав из `/api/auth/me` только чтобы спрятать недоступные кнопки;
решение всегда за сервером.

### Временные ключи

```
                  POST /api/auth/login  { email, password }
браузер ───────────────────────────────────────────────────► API
        ◄───────────────────────────────────────────────────
          200 { accessToken (JWT, 15 мин) }
          Set-Cookie: refresh_token=<sessionId>.<secret>; HttpOnly; SameSite=Strict; Path=/api/auth

  любые запросы:  Authorization: Bearer <accessToken>
  401 token_expired  →  POST /api/auth/refresh (cookie)  →  новый access + новый refresh
```

| Ключ | Где живёт | Срок | Зачем |
|------|-----------|------|-------|
| **access-токен** (JWT HS256: `sub`, `sid`, `role`, `iss`, `aud`, `exp`, `jti`) | только в памяти вкладки | 15 мин (`ACCESS_TOKEN_TTL_SEC`) | ключ доступа к API |
| **refresh-токен** `<id сессии>.<секрет>` | cookie `HttpOnly`, `SameSite=Strict`, `Path=/api/auth` | 7 дней, продлевается при использовании | получение нового access-токена |

* Access-токен не кладётся в `localStorage` — его не украдёт XSS; refresh-токен JavaScript не
  видит вовсе, а на остальные пути API cookie не отправляется.
* В БД хранится **только SHA-256** от секрета refresh-токена.
* **Ротация**: каждый `/refresh` выдаёт новый refresh-токен, старый перестаёт действовать.
  Если кто-то предъявит уже использованный токен — это признак кражи, и сессия
  **закрывается целиком** (событие `auth.refresh.reuse_detected`). Параллельные обновления
  из нескольких вкладок в течение 30 секунд (`REFRESH_REUSE_GRACE_SEC`) кражей не считаются.
* На каждом запросе сервер сверяет `sid` из токена с таблицей `sessions`: отзыв сессии,
  блокировка пользователя или смена роли действуют **сразу**, не дожидаясь истечения токена.
* Клиент (`client/src/api.js`) на 401 один раз обновляет пару ключей и повторяет запрос;
  одновременные 401 ждут одно общее обновление. После перезагрузки страницы сессия
  восстанавливается по cookie.
* Пароли хранятся как **scrypt** (N=2¹⁵, r=8, p=1, соль 16 байт), сравнение — за постоянное
  время (`crypto.timingSafeEqual`).

## 2. Ошибки и коды возврата HTTP

Любая ошибка — в формате **RFC 9457 Problem Details** с `Content-Type: application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "Unprocessable Entity",
  "status": 422,
  "detail": "Проверьте заполнение полей задачи",
  "instance": "/api/tasks",
  "code": "validation_failed",
  "fields": { "title": "Введите название задачи" },
  "requestId": "4c1b8e0f9d2a47b6a3f1c2d3e4f5a6b7"
}
```

`title` — стандартная фраза кода, `detail` — текст для пользователя, `code` — машиночитаемый
код (клиент ветвится по нему, а не по тексту), `requestId` — тот же идентификатор, что в
заголовке `X-Request-Id` и в журнале: по нему жалоба пользователя находится за секунды.
Для 5xx клиенту уходит только общий текст, стек — в журнал.

| Код | Когда | Заголовки |
|-----|-------|-----------|
| 200 OK | успешное чтение / изменение | |
| 201 Created | создание задачи, регистрация, загрузка файлов | `Location` |
| 202 Accepted | запрос письма восстановления (результат асинхронный и не раскрывается) | |
| 204 No Content | удаление, выход, сброс/смена пароля, отзыв сессий, `OPTIONS` | `Allow` для `OPTIONS` |
| 400 Bad Request | битый JSON, неизвестные поля, не тот тип значения, некорректный UUID, неверные параметры выборки, недействительная ссылка сброса | |
| 401 Unauthorized | нет ключа, ключ истёк/подделан, сессия отозвана, неверный логин/пароль | `WWW-Authenticate: Bearer realm="api"[, error="invalid_token"]` (RFC 6750) |
| 403 Forbidden | роль не даёт права на действие; учётная запись заблокирована | |
| 404 Not Found | ресурса нет **или** он недоступен пользователю | |
| 405 Method Not Allowed | метод не поддерживается ресурсом (`PUT /api/tasks`) | `Allow: GET, POST, HEAD, OPTIONS` |
| 409 Conflict | email уже занят; администратор пытается разжаловать/заблокировать сам себя; гонка уникальности в БД (`23505`) | |
| 413 Content Too Large | файл > 10 МБ, больше 5 файлов, JSON-тело > 256 КБ | |
| 415 Unsupported Media Type | тело не в `application/json` / `multipart/form-data` | |
| 422 Unprocessable Content | синтаксис верный, но значения полей не проходят проверку (`fields`) | |
| 429 Too Many Requests | блокировка после неудачных попыток входа; превышен лимит запросов | `Retry-After`, `RateLimit-*` |
| 500 Internal Server Error | непредвиденная ошибка | |
| 503 Service Unavailable | база данных недоступна (`ECONNREFUSED`, `57P01`…), `/api/health` при падении БД | `Retry-After` |

Разделение 400 и 422: 400 — «запрос собран неправильно» (ошибка клиента-программы), 422 —
«пользователь ввёл неподходящие значения» (ошибки показываются под полями формы).

Реализация: `server/src/lib/httpError.js` (фабрики ошибок с нужными заголовками),
`server/src/middleware/errors.js` (приведение любой ошибки — multer, body-parser, pg — к
правильному коду, сериализация в problem+json, `methodNotAllowed`), `client/src/api.js`
(разбор problem+json в `ApiError` с `code`, `fields`, `retryAfter`, `requestId`).

## 3. Защита доступа

### Защита от подбора учётных данных

* **По учётной записи**: после 5 неудачных попыток подряд (`LOGIN_MAX_FAILURES_PER_ACCOUNT`)
  вход закрывается на 15 минут (`LOGIN_LOCKOUT_SEC`) — даже с верным паролем. Ответ —
  `429` с `Retry-After`; интерфейс показывает обратный отсчёт. Владельцу уходит письмо
  «вход заблокирован» со ссылкой на смену пароля. Успешный вход, сброс пароля или
  администратор («Разблокировать вход») обнуляют счётчик.
* **По IP**: не больше 20 неудач за 15 минут с одного адреса по любым email — защита от
  перебора одного пароля по многим учётным записям (password spraying).
* **Общий лимит частоты** на публичные auth-эндпоинты и отдельный строгий лимит на отправку
  писем (`/password/forgot`: 5 за 15 минут с IP) — `429` + заголовки `RateLimit-Limit`,
  `RateLimit-Remaining`, `RateLimit-Reset`.
* **Без утечки информации о пользователях**: неверный пароль и несуществующий email дают
  одинаковый `401`; счётчик ведётся по email независимо от того, есть ли такой пользователь,
  поэтому блокировка тоже ничего не выдаёт; для несуществующего пользователя пароль всё равно
  сверяется с хешем-пустышкой — время ответа одинаковое; о блокировке администратором
  (`403`) сообщается только после верного пароля.
* Попытки хранятся в таблице `login_attempts` (переживают перезапуск API), старше 30 дней
  удаляются автоматически. `trust proxy` настроен так, что за nginx учитывается реальный IP
  клиента, а не адрес прокси.

### Контроль активных подключений

* Каждый вход — отдельная **сессия** (`sessions`: IP, User-Agent, время входа и последней
  активности, срок действия).
* **Лимит**: не более 5 одновременных сессий на пользователя (`MAX_SESSIONS_PER_USER`); при
  входе сверх лимита самая давно неактивная закрывается (событие `auth.session.evicted`).
  Проверка лимита выполняется под блокировкой строки пользователя — гонкой параллельных
  входов его не обойти.
* Раздел **«Безопасность»**: список своих подключений с отметкой текущего, завершение любого
  из них или всех, кроме текущего.
* Администратор в разделе **«Пользователи»** видит число активных сессий каждого и может
  завершить их принудительно; блокировка пользователя сразу закрывает все его сессии.
* Смена пароля закрывает все остальные сессии, сброс пароля по email — все сессии вообще.

### Восстановление доступа через email

```
«Забыли пароль?» → POST /api/auth/password/forgot { email }   → 202 (всегда одинаковый ответ)
                   письмо: http://localhost:8089/reset-password?token=…   (Mailpit: localhost:8026)
ссылка из письма → POST /api/auth/password/reset { token, password }  → 204
```

* Токен — 32 случайных байта, в БД только SHA-256, живёт 30 минут
  (`PASSWORD_RESET_TTL_SEC`), **одноразовый** (гасится атомарным `UPDATE … WHERE used_at IS NULL`);
  новый запрос делает прежние ссылки недействительными.
* Ответ на запрос письма одинаков для любых адресов, а само письмо отправляется в фоне —
  ни текст, ни время ответа не выдают, зарегистрирован ли email.
* После сброса закрываются **все** сессии пользователя и снимается блокировка входа.
* В `docker-compose` письма перехватывает **Mailpit** — их видно в веб-интерфейсе на
  <http://localhost:8026>. Для настоящей почты достаточно задать `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`.

## 4. Структурированное логирование

API пишет журнал через **pino**: одна JSON-строка на запись в stdout (`docker compose logs api`).

```json
{"level":"warn","time":"2026-09-25T11:07:12.589Z","service":"spp-lab3-api","env":"production",
 "reqId":"166ce340c9e07a2408d261e3e1cd6dd0","event":"auth.login.failed",
 "email":"student@example.com","ip":"172.28.0.1","failures":3,"msg":"auth.login.failed"}
{"level":"warn","time":"2026-09-25T11:07:12.590Z","service":"spp-lab3-api","env":"production",
 "req":{"id":"166ce340c9e07a2408d261e3e1cd6dd0","method":"POST","url":"/api/auth/login","ip":"172.28.0.1","userAgent":"Mozilla/5.0 …"},
 "res":{"statusCode":401},"responseTime":78,"msg":"POST /api/auth/login → 401"}
```

* **Запись о каждом запросе**: метод, путь, код ответа, время обработки, IP, User-Agent,
  `userId`. Уровень зависит от результата: `info` — 2xx/3xx, `warn` — 4xx, `error` — 5xx.
  Проба `/api/health` в журнал не пишется.
* **Сквозной `reqId`**: nginx генерирует `$request_id`, передаёт его в API заголовком
  `X-Request-Id` и пишет в свой JSON-журнал; API возвращает его клиенту в заголовке и в теле
  ошибки. Одна и та же строка связывает запись nginx, запись API и сообщение пользователя.
* **События безопасности** с машиночитаемым полем `event`: `auth.login.success`,
  `auth.login.failed`, `auth.account.locked`, `auth.login.locked_attempt`,
  `auth.login.ip_blocked`, `auth.refresh.reuse_detected`, `auth.session.evicted`,
  `auth.session.revoked`, `auth.password_reset.requested`, `auth.password_reset.completed`,
  `auth.password_change.completed`, `users.updated`, `users.unlocked`, `access.denied`,
  `rate_limit.exceeded`, `mail.sent`, `mail.failed`; действия с задачами — `task.created`,
  `task.updated`, `task.deleted`.
* **Секреты не попадают в журнал**: заголовки `Authorization`, `Cookie`, `Set-Cookie` и поля
  `password`, `token`, `accessToken`, `refreshToken` заменяются на `[REDACTED]`.
* Для 5xx пишется полный стек (`err`), клиенту — только общий текст и `requestId`.
* Уровень задаётся `LOG_LEVEL` (`trace` … `fatal`, `silent` — в тестах). ESLint-правило
  `no-console` не даёт вернуть в код неструктурированный `console.log`.
* nginx пишет access-журнал тоже в JSON (`client/nginx.conf`, `log_format json_combined`).

## 5. Автоматическая проверка кода

**GitHub Actions** — `.github/workflows/lab3.yml` в корне репозитория. Запускается на каждый
`push` и `pull_request`, затрагивающий `Lab3/**`, и вручную (`workflow_dispatch`):

| Задача | Что делает |
|--------|------------|
| `server` | `npm ci` → **ESLint** → **46 автотестов** (`node:test` + supertest) на настоящем PostgreSQL 16 из service-контейнера |
| `client` | `npm ci` → **ESLint** (правила React и React Hooks) → **production-сборка** Vite |
| `docker` | после успеха первых двух: `docker compose config` и **сборка всех образов** |
| `audit` | `npm audit --omit=dev --audit-level=high` для сервера и клиента |

Новый push в ту же ветку отменяет устаревший прогон (`concurrency`). Чтобы красная проверка
блокировала слияние, в настройках репозитория включается *Branch protection rule* для `main`
с обязательными проверками.

Что покрывают тесты (`server/test/`):

* `unit.test.js` — хеширование паролей и политика паролей, матрица прав ролей, подпись и
  разбор временных ключей, заголовки `HttpError`, проверка тел запросов;
* `auth.test.js` — регистрация (201/409/422/400/415), одинаковый 401 для неверного пароля и
  несуществующего email, блокировка после серии неудач (429 + `Retry-After` + письмо),
  блокировка несуществующего email, сброс счётчика, разблокировка администратором,
  ротация refresh-токена и обнаружение его повторного использования, выход, лимит сессий,
  завершение своей и попытка завершить чужую сессию (404), полный цикл восстановления пароля
  по письму (одноразовость, истечение, снятие блокировки), смена пароля;
* `access.test.js` — изоляция задач пользователей (404 на чужие), права менеджера (403 на
  удаление чужой), права администратора, смена роли без повторного входа, блокировка
  пользователя, запрет на самоблокировку (409), 405 + `Allow`, формат problem+json,
  400/422/415/413, 201 + `Location`, 204.

**Локальный pre-commit-хук** (`.githooks/pre-commit`) прогоняет ESLint по изменённым частям
Lab3 до коммита. Включается один раз:

```bash
git config core.hooksPath .githooks
```

## REST API

Базовый путь — `/api`. 🔓 — доступно без входа, остальное требует `Authorization: Bearer`.
Все ресурсы отвечают на `OPTIONS` списком методов, на неподдерживаемый метод — `405`.

### Аутентификация и сессии

| Метод | Путь | Назначение | Успех | Ошибки |
|-------|------|------------|-------|--------|
| POST 🔓 | `/api/auth/register` | регистрация (роль `user`) + вход | 201 | 400, 409, 415, 422, 429 |
| POST 🔓 | `/api/auth/login` | вход | 200 | 400, 401, 403, 415, 422, 429 |
| POST 🔓 | `/api/auth/refresh` | новая пара ключей по refresh-cookie | 200 | 401, 429 |
| POST 🔓 | `/api/auth/logout` | завершить текущую сессию | 204 | — |
| POST 🔓 | `/api/auth/password/forgot` | письмо со ссылкой восстановления | 202 | 400, 415, 422, 429 |
| POST 🔓 | `/api/auth/password/reset` | новый пароль по токену из письма | 204 | 400, 415, 422 |
| GET | `/api/auth/me` | текущий пользователь, роль, права | 200 | 401 |
| POST | `/api/auth/password/change` | смена пароля (остальные сессии закрываются) | 204 | 401, 422 |
| GET | `/api/auth/sessions` | мои активные подключения | 200 | 401 |
| DELETE | `/api/auth/sessions` | завершить все, кроме текущей | 204 | 401 |
| DELETE | `/api/auth/sessions/:id` | завершить одну сессию | 204 | 400, 401, 404 |

### Пользователи

| Метод | Путь | Кому | Успех | Ошибки |
|-------|------|------|-------|--------|
| GET | `/api/users` | manager, admin | 200 | 401, 403 |
| PATCH | `/api/users/:id` `{ role?, isActive? }` | admin | 200 | 400, 401, 403, 404, 409, 422 |
| GET | `/api/users/:id/sessions` | admin | 200 | 401, 403, 404 |
| DELETE | `/api/users/:id/sessions` | admin | 204 | 401, 403, 404 |
| DELETE | `/api/users/:id/lock` | admin — снять блокировку входа | 204 | 401, 403, 404 |

### Задачи и вложения

| Метод | Путь | Назначение | Успех | Ошибки |
|-------|------|------------|-------|--------|
| GET 🔓 | `/api/meta` | справочник статусов, ролей и лимитов | 200 | — |
| GET 🔓 | `/api/health` | проба живости | 200 | 503 |
| GET | `/api/tasks?status=&q=&sort=&scope=all\|mine` | список задач и счётчики | 200 | 400, 401 |
| POST | `/api/tasks` | создание (JSON или multipart с файлами) | 201 + `Location` | 401, 403, 413, 415, 422 |
| GET | `/api/tasks/:id` | одна задача | 200 | 400, 401, 404 |
| PUT | `/api/tasks/:id` | полная замена полей | 200 | 400, 401, 403, 404, 413, 415, 422 |
| PATCH | `/api/tasks/:id` | частичное изменение | 200 | 400, 401, 403, 404, 415, 422 |
| DELETE | `/api/tasks/:id` | удаление с вложениями | 204 | 400, 401, 403, 404 |
| POST | `/api/tasks/:id/attachments` | загрузка файлов | 201 + `Location` | 400, 401, 403, 404, 413, 415, 422 |
| GET | `/api/tasks/:id/attachments/:fileId` | скачивание | 200 | 400, 401, 404 |
| DELETE | `/api/tasks/:id/attachments/:fileId` | удаление файла | 204 | 400, 401, 403, 404 |

Пользователь получает в списке только свои задачи; менеджер и администратор — все
(`scope=mine` — только свои). У каждой задачи есть `ownerId` и `owner { id, name, email }`.
Скачивание вложений в SPA идёт через `fetch` с ключом доступа (обычная ссылка не приложила
бы заголовок `Authorization`).

### Примеры

```bash
API=http://localhost:3003/api

# вход: access-токен в ответе, refresh-токен — в cookie-файле
TOKEN=$(curl -s -c cookies.txt -X POST $API/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"Admin12345"}' | jq -r .accessToken)

curl -i $API/tasks -H "Authorization: Bearer $TOKEN"
curl -i -X PUT $API/tasks -H "Authorization: Bearer $TOKEN"          # 405 + Allow
curl -i $API/tasks                                                   # 401 + WWW-Authenticate
curl -s -b cookies.txt -c cookies.txt -X POST $API/auth/refresh      # новая пара ключей
curl -s $API/auth/sessions -H "Authorization: Bearer $TOKEN"         # активные подключения
```

## Хранение данных

К таблицам ЛР №2 (`tasks`, `attachments`) добавлены:

```
users            id, email UNIQUE (в нижнем регистре), name, password_hash (scrypt),
                 role CHECK IN ('user','manager','admin'), is_active, created_at, updated_at,
                 password_changed_at
sessions         id, user_id → users, refresh_hash, prev_refresh_hash, rotated_at,
                 ip, user_agent, created_at, last_seen_at, expires_at, revoked_at, revoke_reason
login_attempts   id, email, ip, success, reason, created_at        — защита от подбора
password_resets  id, user_id → users, token_hash UNIQUE, expires_at, used_at, created_at
tasks            + owner_id → users ON DELETE CASCADE
```

Закрытые сессии не удаляются сразу — `revoked_at` и `revoke_reason` (`logout`,
`session_limit`, `refresh_reuse`, `password_reset`, `admin_revoked`…) остаются для разбора
инцидентов; записи старше 30 дней API вычищает сам раз в час.

## Структура проекта (что добавилось к ЛР №2)

```
.github/workflows/lab3.yml     # CI: lint, тесты с PostgreSQL, сборка, docker, audit
.githooks/pre-commit           # локальный ESLint перед коммитом
Lab3/
├── docker-compose.yml         # db, api, web + mail (Mailpit)
├── server/
│   ├── eslint.config.js
│   ├── test/                  # unit.test.js, auth.test.js, access.test.js, helpers.js
│   └── src/
│       ├── services/authService.js       # вход, блокировки, ротация ключей, сброс пароля
│       ├── routes/auth.js                # /api/auth/**
│       ├── routes/users.js               # /api/users/** (администрирование)
│       ├── middleware/auth.js            # проверка Bearer-ключа и сессии, requirePermission
│       ├── middleware/rateLimit.js       # 429 + Retry-After + RateLimit-*
│       ├── middleware/requestLogger.js   # pino-http, reqId
│       ├── repositories/userRepository.js, sessionRepository.js,
│       │   loginAttemptRepository.js, passwordResetRepository.js
│       └── lib/roles.js, tokens.js, password.js, authValidation.js, mailer.js, logger.js
└── client/
    ├── eslint.config.js
    └── src/
        ├── api.js                 # ключи в памяти, авто-refresh, разбор problem+json
        ├── lib/router.js          # маршруты на History API (/login, /reset-password…)
        ├── lib/permissions.js     # зеркало прав для интерфейса
        └── pages/AuthPage.jsx, TasksPage.jsx, SecurityPage.jsx, UsersPage.jsx
```

## Отличия от лабораторной работы №2

| | ЛР №2 | ЛР №3 |
|---|-------|-------|
| Доступ | открыт всем | вход обязателен, три роли, права на уровне отдельной задачи |
| Аутентификация | нет | JWT на 15 минут + refresh-токен в HttpOnly-cookie с ротацией |
| Формат ошибок | `{ error: { status, message, fields } }` | RFC 9457 `application/problem+json` + `code`, `requestId` |
| Коды | 200/201/204/400/404/415/500 | + 202, 401, 403, 405, 409, 413, 422, 429, 503 и их заголовки |
| Защита | — | блокировка после неудачных входов, лимиты частоты, лимит сессий, сброс пароля по email |
| Журнал | `console.log` | pino (JSON), события безопасности, сквозной `reqId` с nginx |
| Проверка кода | вручную | GitHub Actions + ESLint + 46 автотестов + pre-commit |
