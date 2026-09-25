-- Схема БД менеджера задач. Скрипт идемпотентен и выполняется при каждом старте API.

-- Пользователи. email храним в нижнем регистре — уникальность без учёта регистра.
CREATE TABLE IF NOT EXISTS users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254),
  name          TEXT        NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  password_hash TEXT        NOT NULL,
  role          TEXT        NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'manager', 'admin')),
  is_active     BOOLEAN     NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Сессии (активные подключения). Одна сессия = один вход с одного устройства.
-- refresh_hash — SHA-256 текущего refresh-токена, prev_refresh_hash — предыдущего
-- (нужен, чтобы отличить гонку параллельных обновлений от повторного использования
-- украденного токена).
CREATE TABLE IF NOT EXISTS sessions (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_hash      TEXT        NOT NULL,
  prev_refresh_hash TEXT,
  rotated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip                TEXT,
  user_agent        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  revoked_at        TIMESTAMPTZ,
  revoke_reason     TEXT
);

CREATE INDEX IF NOT EXISTS sessions_user_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- Журнал попыток входа — основа защиты от подбора пароля. Попытки считаются
-- по email (независимо от того, существует ли такой пользователь) и по IP.
-- success = true — успешный вход или сброс пароля: он обнуляет счётчик неудач.
CREATE TABLE IF NOT EXISTS login_attempts (
  id         BIGSERIAL   PRIMARY KEY,
  email      TEXT        NOT NULL,
  ip         TEXT,
  success    BOOLEAN     NOT NULL,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_attempts_email_idx ON login_attempts (email, created_at DESC);
CREATE INDEX IF NOT EXISTS login_attempts_ip_idx    ON login_attempts (ip, created_at DESC);

-- Одноразовые токены восстановления доступа по email.
CREATE TABLE IF NOT EXISTS password_resets (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT        NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id);

CREATE TABLE IF NOT EXISTS tasks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id    UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT        NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description TEXT        NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  status      TEXT        NOT NULL DEFAULT 'todo'
                          CHECK (status IN ('todo', 'in_progress', 'done')),
  due_date    DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ON DELETE CASCADE: вложения удалённой задачи уходят из БД вместе с ней,
-- файлы с диска подчищает репозиторий по списку stored_name.
CREATE TABLE IF NOT EXISTS attachments (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID        NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  original_name TEXT        NOT NULL,
  stored_name   TEXT        NOT NULL UNIQUE,
  size          BIGINT      NOT NULL CHECK (size >= 0),
  mime_type     TEXT        NOT NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attachments_task_id_idx ON attachments (task_id);
CREATE INDEX IF NOT EXISTS tasks_owner_idx         ON tasks (owner_id);
CREATE INDEX IF NOT EXISTS tasks_status_idx        ON tasks (status);
CREATE INDEX IF NOT EXISTS tasks_due_date_idx      ON tasks (due_date);
