'use strict';

const { pool } = require('../db/pool');

const ROUND_SELECT = `
  id,
  started_at  AS "startedAt",
  ends_at     AS "endsAt",
  finished_at AS "finishedAt",
  winner_team AS "winnerTeam",
  scores
`;

const PLAYER_SELECT = `
  id, name, team, charges,
  charges_at   AS "chargesAt",
  pixels_total AS "pixelsTotal"
`;

/** Весь SQL игры. client — пул или соединение внутри транзакции. */
const repository = {
  async getActiveRound(client = pool) {
    const { rows } = await client.query(`SELECT ${ROUND_SELECT} FROM rounds WHERE finished_at IS NULL`);
    return rows[0] || null;
  },

  async createRound(durationSec, client = pool) {
    const { rows } = await client.query(
      `INSERT INTO rounds (ends_at) VALUES (now() + make_interval(secs => $1)) RETURNING ${ROUND_SELECT}`,
      [durationSec]
    );
    return rows[0];
  },

  async finishRound(id, winnerTeam, scores, client = pool) {
    await client.query('UPDATE rounds SET finished_at = now(), winner_team = $2, scores = $3 WHERE id = $1', [
      id,
      winnerTeam,
      JSON.stringify(scores)
    ]);
  },

  /** Удаляет поле и журнал ходов старых раундов, оставляя keep последних. */
  async pruneRounds(keep, client = pool) {
    await client.query(
      `DELETE FROM rounds WHERE id NOT IN (SELECT id FROM rounds ORDER BY id DESC LIMIT $1)`,
      [keep]
    );
  },

  async recentRounds(limit, client = pool) {
    const { rows } = await client.query(
      `SELECT ${ROUND_SELECT} FROM rounds WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT $1`,
      [limit]
    );
    return rows;
  },

  /** Поле раунда вместе с именами владельцев клеток. */
  async loadBoard(roundId, client = pool) {
    const { rows } = await client.query(
      `SELECT c.x, c.y, c.team, c.version, c.player_id AS "playerId", p.name AS "playerName"
         FROM cells c LEFT JOIN players p ON p.id = c.player_id
        WHERE c.round_id = $1`,
      [roundId]
    );
    return rows;
  },

  /** Сколько клеток закрасил каждый игрок в раунде (для таблицы лидеров). */
  async roundPixels(roundId, client = pool) {
    const { rows } = await client.query(
      `SELECT m.player_id AS id, p.name, p.team, COUNT(*)::int AS pixels
         FROM moves m JOIN players p ON p.id = m.player_id
        WHERE m.round_id = $1 AND m.status = 'ok'
        GROUP BY m.player_id, p.name, p.team`,
      [roundId]
    );
    return rows;
  },

  async maxSeq(client = pool) {
    const { rows } = await client.query(
      `SELECT COALESCE(MAX(seq), 0)::bigint AS seq FROM moves WHERE status = 'ok'`
    );
    return Number(rows[0].seq);
  },

  /** Применённые изменения после seq — для дельта-синхронизации. */
  async changesSince(roundId, afterSeq, limit, client = pool) {
    const { rows } = await client.query(
      `SELECT seq, x, y, team, cell_version AS version
         FROM moves
        WHERE round_id = $1 AND status = 'ok' AND seq > $2
        ORDER BY seq
        LIMIT $3`,
      [roundId, afterSeq, limit]
    );
    return rows.map((row) => [Number(row.seq), row.x, row.y, row.team, row.version]);
  },

  async createPlayer({ tokenHash, name, team, charges }, client = pool) {
    const { rows } = await client.query(
      `INSERT INTO players (token_hash, name, team, charges) VALUES ($1, $2, $3, $4) RETURNING ${PLAYER_SELECT}`,
      [tokenHash, name, team, charges]
    );
    return rows[0];
  },

  async findPlayerByTokenHash(tokenHash, client = pool) {
    const { rows } = await client.query(
      `UPDATE players SET last_seen_at = now() WHERE token_hash = $1 RETURNING ${PLAYER_SELECT}`,
      [tokenHash]
    );
    return rows[0] || null;
  },

  async findPlayer(id, client = pool) {
    const { rows } = await client.query(`SELECT ${PLAYER_SELECT} FROM players WHERE id = $1`, [id]);
    return rows[0] || null;
  },

  /** Блокирует строку игрока до конца транзакции: заряды списываются строго по очереди. */
  async lockPlayer(id, client) {
    const { rows } = await client.query(`SELECT ${PLAYER_SELECT} FROM players WHERE id = $1 FOR UPDATE`, [
      id
    ]);
    return rows[0] || null;
  },

  async savePlayerAfterPaint(id, { charges, chargesAt }, painted, client) {
    await client.query(
      `UPDATE players
          SET charges = $2, charges_at = to_timestamp($3 / 1000.0),
              pixels_total = pixels_total + $4, last_seen_at = now()
        WHERE id = $1`,
      [id, charges, chargesAt, painted ? 1 : 0]
    );
  },

  /** Ход, уже обработанный ранее (повторная отправка того же actionId). */
  async findMove(playerId, actionId, client = pool) {
    const { rows } = await client.query(
      `SELECT seq, round_id AS "roundId", x, y, status, cell_version AS "cellVersion"
         FROM moves WHERE player_id = $1 AND action_id = $2`,
      [playerId, actionId]
    );
    return rows[0] || null;
  },

  /**
   * Запись клетки с проверкой версии (compare-and-set).
   * Строка обновляется только если её версия всё ещё равна baseVersion;
   * для пустой клетки (baseVersion = 0) строки быть не должно.
   * Возвращает новую версию или null, если клетку уже успели изменить.
   */
  async writeCell({ roundId, x, y, team, playerId, baseVersion }, client) {
    const { rows } =
      baseVersion === 0
        ? await client.query(
            `INSERT INTO cells (round_id, x, y, team, player_id, version)
             VALUES ($1, $2, $3, $4, $5, 1)
             ON CONFLICT (round_id, x, y) DO NOTHING
             RETURNING version`,
            [roundId, x, y, team, playerId]
          )
        : await client.query(
            `UPDATE cells SET team = $4, player_id = $5, version = version + 1, updated_at = now()
              WHERE round_id = $1 AND x = $2 AND y = $3 AND version = $6
              RETURNING version`,
            [roundId, x, y, team, playerId, baseVersion]
          );
    return rows[0] ? rows[0].version : null;
  },

  async insertMove(move, client) {
    const { rows } = await client.query(
      `INSERT INTO moves (round_id, player_id, action_id, x, y, team, status, cell_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING seq`,
      [move.roundId, move.playerId, move.actionId, move.x, move.y, move.team, move.status, move.cellVersion]
    );
    return Number(rows[0].seq);
  }
};

module.exports = { repository };
