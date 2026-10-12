-- Схема «Пиксельной битвы». Скрипт идемпотентен и выполняется при каждом старте.

-- Игроки. Входа по паролю нет: при первом входе игрок получает случайный токен,
-- который хранится в localStorage браузера; в БД — только его SHA-256.
CREATE TABLE IF NOT EXISTS players (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   TEXT        NOT NULL UNIQUE,
  name         TEXT        NOT NULL CHECK (length(name) BETWEEN 2 AND 20),
  team         SMALLINT    NOT NULL CHECK (team BETWEEN 0 AND 3),
  -- Заряды хранятся «лениво»: значение на момент charges_at, восстановление
  -- досчитывается при следующем обращении (см. src/game/charges.js).
  charges      SMALLINT    NOT NULL CHECK (charges >= 0),
  charges_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  pixels_total INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Раунды. Активный раунд — тот, у которого finished_at IS NULL; такой может быть только один.
CREATE TABLE IF NOT EXISTS rounds (
  id          SERIAL      PRIMARY KEY,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at     TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  winner_team SMALLINT,
  scores      JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS rounds_single_active_idx ON rounds ((true)) WHERE finished_at IS NULL;

-- Поле раунда. version растёт на 1 при каждой перекраске клетки —
-- по ней сервер обнаруживает одновременные изменения (оптимистическая блокировка).
-- Отсутствие строки = пустая клетка с версией 0.
CREATE TABLE IF NOT EXISTS cells (
  round_id   INTEGER     NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  x          SMALLINT    NOT NULL,
  y          SMALLINT    NOT NULL,
  team       SMALLINT    NOT NULL,
  player_id  UUID        REFERENCES players(id) ON DELETE SET NULL,
  version    INTEGER     NOT NULL CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, x, y)
);

-- Журнал ходов.
--  seq       — глобальный порядковый номер: по нему переподключившийся клиент
--              получает только пропущенные изменения (дельта-синхронизация);
--  action_id — идентификатор хода, сгенерированный клиентом. UNIQUE (player_id, action_id)
--              делает повторную отправку хода после обрыва связи безопасной (идемпотентность).
CREATE TABLE IF NOT EXISTS moves (
  seq          BIGSERIAL   PRIMARY KEY,
  round_id     INTEGER     NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  player_id    UUID        NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  action_id    UUID        NOT NULL,
  x            SMALLINT    NOT NULL,
  y            SMALLINT    NOT NULL,
  team         SMALLINT    NOT NULL,
  status       TEXT        NOT NULL CHECK (status IN ('ok', 'conflict', 'no_charges')),
  cell_version INTEGER     NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (player_id, action_id)
);

CREATE INDEX IF NOT EXISTS moves_round_applied_idx ON moves (round_id, seq) WHERE status = 'ok';
