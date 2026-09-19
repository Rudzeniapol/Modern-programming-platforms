-- Схема БД менеджера задач. Скрипт идемпотентен и выполняется при каждом старте API.

CREATE TABLE IF NOT EXISTS tasks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
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
CREATE INDEX IF NOT EXISTS tasks_status_idx        ON tasks (status);
CREATE INDEX IF NOT EXISTS tasks_due_date_idx      ON tasks (due_date);
