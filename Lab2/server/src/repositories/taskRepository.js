'use strict';

const fs = require('fs/promises');
const path = require('path');

const { uploadsDir } = require('../config');
const { query, withTransaction } = require('../db/pool');

// Задача отдаётся клиенту вместе с вложениями одним запросом:
// подзапрос собирает их в JSON-массив, чтобы не было проблемы N+1.
const TASK_SELECT = `
  t.id,
  t.title,
  t.description,
  t.status,
  to_char(t.due_date, 'YYYY-MM-DD')          AS "dueDate",
  t.created_at                               AS "createdAt",
  t.updated_at                               AS "updatedAt",
  COALESCE((
    SELECT json_agg(
             json_build_object(
               'id',           a.id,
               'originalName', a.original_name,
               'storedName',   a.stored_name,
               'size',         a.size,
               'mimeType',     a.mime_type,
               'uploadedAt',   a.uploaded_at
             )
             ORDER BY a.uploaded_at, a.id
           )
    FROM attachments a
    WHERE a.task_id = t.id
  ), '[]'::json)                             AS attachments
`;

// sort приходит из whitelist-проверки в validation.js, поэтому подстановка безопасна.
const ORDER_BY = {
  dueDate: 't.due_date ASC NULLS LAST, t.created_at DESC',
  created: 't.created_at DESC',
  title: 't.title ASC'
};

const UPDATABLE_COLUMNS = {
  title: { column: 'title', cast: '' },
  description: { column: 'description', cast: '' },
  status: { column: 'status', cast: '' },
  dueDate: { column: 'due_date', cast: '::date' }
};

// В ILIKE символы % и _ — подстановочные. Экранируем их,
// иначе поиск по строке «100%» найдёт вообще всё.
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

async function selectTask(client, id) {
  const { rows } = await client.query(`SELECT ${TASK_SELECT} FROM tasks t WHERE t.id = $1`, [id]);
  return rows[0] || null;
}

async function insertAttachments(client, taskId, files = []) {
  for (const file of files) {
    await client.query(
      `INSERT INTO attachments (task_id, original_name, stored_name, size, mime_type)
       VALUES ($1, $2, $3, $4, $5)`,
      [taskId, file.originalname, file.filename, file.size, file.mimetype]
    );
  }
}

/**
 * Удаляет файлы с диска. Отсутствие файла не считается ошибкой:
 * запись в БД уже удалена, восстанавливать нечего.
 */
async function removeStoredFiles(storedNames = []) {
  await Promise.all(
    storedNames.map(async (storedName) => {
      try {
        await fs.unlink(path.join(uploadsDir, storedName));
      } catch (error) {
        if (error.code !== 'ENOENT') {
          console.error(`Не удалось удалить файл ${storedName}:`, error.message);
        }
      }
    })
  );
}

const taskRepository = {
  /** Список задач: фильтр по статусу, поиск по названию и описанию, сортировка. */
  async list({ status = 'all', q = '', sort = 'dueDate' } = {}) {
    const { rows } = await query(
      `SELECT ${TASK_SELECT}
         FROM tasks t
        WHERE ($1::text = 'all' OR t.status = $1::text)
          AND ($2::text = ''
               OR t.title ILIKE '%' || $2::text || '%'
               OR t.description ILIKE '%' || $2::text || '%')
        ORDER BY ${ORDER_BY[sort] || ORDER_BY.dueDate}`,
      [status, escapeLike(q)]
    );
    return rows;
  },

  /**
   * Счётчики для вкладок фильтра. Учитывают поисковый запрос, но не выбранный
   * статус — иначе на вкладках всегда была бы одна ненулевая цифра.
   */
  async counts({ q = '' } = {}) {
    const { rows } = await query(
      `SELECT status, COUNT(*)::int AS count
         FROM tasks
        WHERE ($1::text = ''
               OR title ILIKE '%' || $1::text || '%'
               OR description ILIKE '%' || $1::text || '%')
        GROUP BY status`,
      [escapeLike(q)]
    );

    return rows.reduce(
      (acc, row) => {
        acc[row.status] = row.count;
        acc.all += row.count;
        return acc;
      },
      { all: 0, todo: 0, in_progress: 0, done: 0 }
    );
  },

  async findById(id) {
    const { rows } = await query(`SELECT ${TASK_SELECT} FROM tasks t WHERE t.id = $1`, [id]);
    return rows[0] || null;
  },

  /** Создаёт задачу вместе с вложениями в одной транзакции. */
  async create(values, files = []) {
    return withTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO tasks (title, description, status, due_date)
         VALUES ($1, $2, $3, $4::date)
         RETURNING id`,
        [values.title, values.description, values.status, values.dueDate]
      );
      const taskId = rows[0].id;
      await insertAttachments(client, taskId, files);
      return selectTask(client, taskId);
    });
  },

  /**
   * Обновляет переданные поля задачи и добавляет новые вложения.
   * Возвращает null, если задачи с таким id нет (маршрут ответит 404).
   */
  async update(id, values = {}, files = []) {
    return withTransaction(async (client) => {
      const params = [];
      const assignments = [];

      for (const [field, { column, cast }] of Object.entries(UPDATABLE_COLUMNS)) {
        if (field in values) {
          params.push(values[field]);
          assignments.push(`${column} = $${params.length}${cast}`);
        }
      }

      assignments.push('updated_at = now()');
      params.push(id);

      const { rowCount } = await client.query(
        `UPDATE tasks SET ${assignments.join(', ')} WHERE id = $${params.length} RETURNING id`,
        params
      );
      if (rowCount === 0) return null;

      await insertAttachments(client, id, files);
      return selectTask(client, id);
    });
  },

  /**
   * Удаляет задачу. Записи о вложениях уходят по ON DELETE CASCADE,
   * а сами файлы убираем с диска уже после успешного коммита.
   */
  async remove(id) {
    const storedNames = await withTransaction(async (client) => {
      const { rows: files } = await client.query(
        'SELECT stored_name FROM attachments WHERE task_id = $1',
        [id]
      );
      const { rowCount } = await client.query('DELETE FROM tasks WHERE id = $1', [id]);
      if (rowCount === 0) return null;
      return files.map((row) => row.stored_name);
    });

    if (storedNames === null) return false;
    await removeStoredFiles(storedNames);
    return true;
  },

  async findAttachment(taskId, attachmentId) {
    const { rows } = await query(
      `SELECT id,
              original_name AS "originalName",
              stored_name   AS "storedName",
              size,
              mime_type     AS "mimeType"
         FROM attachments
        WHERE id = $1 AND task_id = $2`,
      [attachmentId, taskId]
    );
    return rows[0] || null;
  },

  /** Удаляет одно вложение; возвращает false, если задачи или файла нет. */
  async removeAttachment(taskId, attachmentId) {
    const storedName = await withTransaction(async (client) => {
      const { rows } = await client.query(
        'DELETE FROM attachments WHERE id = $1 AND task_id = $2 RETURNING stored_name',
        [attachmentId, taskId]
      );
      if (!rows.length) return null;
      await client.query('UPDATE tasks SET updated_at = now() WHERE id = $1', [taskId]);
      return rows[0].stored_name;
    });

    if (storedName === null) return false;
    await removeStoredFiles([storedName]);
    return true;
  },

  async exists(id) {
    const { rowCount } = await query('SELECT 1 FROM tasks WHERE id = $1', [id]);
    return rowCount > 0;
  }
};

module.exports = { taskRepository, removeStoredFiles };
