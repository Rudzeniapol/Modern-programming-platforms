'use strict';

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { dataFile, uploadsDir } = require('../config');
const { DEFAULT_STATUS } = require('../lib/statuses');

// Все операции чтения/записи выстраиваются в очередь: файл небольшой,
// а последовательный доступ исключает потерю данных при параллельных запросах.
let queue = Promise.resolve();

function serialize(operation) {
  const result = queue.then(operation, operation);
  queue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function readAll() {
  try {
    const raw = await fs.readFile(dataFile, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeAll(tasks) {
  await fs.mkdir(path.dirname(dataFile), { recursive: true });
  const tmp = `${dataFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(tasks, null, 2), 'utf8');
  await fs.rename(tmp, dataFile); // атомарная замена — файл не останется битым
}

function toAttachment(file) {
  return {
    id: crypto.randomUUID(),
    originalName: file.originalname,
    storedName: file.filename,
    size: file.size,
    mimeType: file.mimetype,
    uploadedAt: new Date().toISOString()
  };
}

async function removeFiles(attachments = []) {
  await Promise.all(
    attachments.map(async (attachment) => {
      try {
        await fs.unlink(path.join(uploadsDir, attachment.storedName));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    })
  );
}

const store = {
  /**
   * Список задач с фильтрацией по статусу, поиском по тексту и сортировкой.
   * Фильтрация выполняется на сервере — клиент получает готовую разметку.
   */
  async list({ status = 'all', query = '', sort = 'dueDate' } = {}) {
    const tasks = await serialize(readAll);
    const needle = query.trim().toLowerCase();

    const filtered = tasks.filter((task) => {
      if (status !== 'all' && task.status !== status) return false;
      if (!needle) return true;
      return (
        task.title.toLowerCase().includes(needle) ||
        (task.description || '').toLowerCase().includes(needle)
      );
    });

    const byCreated = (a, b) => b.createdAt.localeCompare(a.createdAt);
    const comparators = {
      created: byCreated,
      title: (a, b) => a.title.localeCompare(b.title, 'ru'),
      dueDate: (a, b) => {
        // задачи без срока уходят в конец списка
        if (!a.dueDate && !b.dueDate) return byCreated(a, b);
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate.localeCompare(b.dueDate) || byCreated(a, b);
      }
    };

    return filtered.sort(comparators[sort] || comparators.dueDate);
  },

  async counts() {
    const tasks = await serialize(readAll);
    return tasks.reduce(
      (acc, task) => {
        acc.all += 1;
        acc[task.status] = (acc[task.status] || 0) + 1;
        return acc;
      },
      { all: 0 }
    );
  },

  async getById(id) {
    const tasks = await serialize(readAll);
    return tasks.find((task) => task.id === id) || null;
  },

  async create(data, files = []) {
    return serialize(async () => {
      const tasks = await readAll();
      const now = new Date().toISOString();
      const task = {
        id: crypto.randomUUID(),
        title: data.title,
        description: data.description || '',
        status: data.status || DEFAULT_STATUS,
        dueDate: data.dueDate || null,
        createdAt: now,
        updatedAt: now,
        attachments: files.map(toAttachment)
      };
      tasks.push(task);
      await writeAll(tasks);
      return task;
    });
  },

  async update(id, data, files = []) {
    return serialize(async () => {
      const tasks = await readAll();
      const task = tasks.find((item) => item.id === id);
      if (!task) return null;

      if (data.title !== undefined) task.title = data.title;
      if (data.description !== undefined) task.description = data.description;
      if (data.status !== undefined) task.status = data.status;
      if (data.dueDate !== undefined) task.dueDate = data.dueDate || null;
      if (files.length) task.attachments.push(...files.map(toAttachment));
      task.updatedAt = new Date().toISOString();

      await writeAll(tasks);
      return task;
    });
  },

  async remove(id) {
    return serialize(async () => {
      const tasks = await readAll();
      const index = tasks.findIndex((task) => task.id === id);
      if (index === -1) return null;

      const [removed] = tasks.splice(index, 1);
      await writeAll(tasks);
      await removeFiles(removed.attachments);
      return removed;
    });
  },

  async removeAttachment(taskId, attachmentId) {
    return serialize(async () => {
      const tasks = await readAll();
      const task = tasks.find((item) => item.id === taskId);
      if (!task) return null;

      const index = task.attachments.findIndex((a) => a.id === attachmentId);
      if (index === -1) return null;

      const [removed] = task.attachments.splice(index, 1);
      task.updatedAt = new Date().toISOString();
      await writeAll(tasks);
      await removeFiles([removed]);
      return removed;
    });
  }
};

module.exports = store;
