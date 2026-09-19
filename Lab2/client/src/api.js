// Единственная точка общения с сервером. Здесь же приводим любой неуспешный
// ответ к одному типу ошибки, чтобы интерфейс показывал понятный текст.

const BASE_URL = import.meta.env.VITE_API_URL || '/api';

export class ApiError extends Error {
  constructor(status, message, fields) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.fields = fields || {};
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const options = { method, headers: {} };

  if (body instanceof FormData) {
    // Content-Type для multipart/form-data браузер выставляет сам —
    // вместе с boundary, который вручную не собрать.
    options.body = body;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, options);
  } catch {
    throw new ApiError(0, 'Сервер недоступен. Проверьте соединение и повторите попытку.');
  }

  if (response.status === 204) return null;

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const error = (payload && payload.error) || {};
    throw new ApiError(
      response.status,
      error.message || `Сервер ответил кодом ${response.status}`,
      error.fields
    );
  }

  return payload;
}

function buildQuery(filter = {}) {
  const params = new URLSearchParams();
  if (filter.status && filter.status !== 'all') params.set('status', filter.status);
  if (filter.sort && filter.sort !== 'dueDate') params.set('sort', filter.sort);
  if (filter.q) params.set('q', filter.q);
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * Собирает multipart/form-data, если к задаче приложены файлы,
 * и обычный JSON, если файлов нет.
 */
function toRequestBody(values, files = []) {
  if (!files.length) return values;

  const form = new FormData();
  for (const [key, value] of Object.entries(values)) {
    form.append(key, value === null ? '' : String(value));
  }
  for (const file of files) form.append('attachments', file);
  return form;
}

export const api = {
  getMeta: () => request('/meta'),

  listTasks: (filter) => request(`/tasks${buildQuery(filter)}`),

  createTask: (values, files) => request('/tasks', { method: 'POST', body: toRequestBody(values, files) }),

  // PUT — полная замена полей задачи, PATCH — точечное изменение (смена статуса).
  replaceTask: (id, values, files) =>
    request(`/tasks/${id}`, { method: 'PUT', body: toRequestBody(values, files) }),

  patchTask: (id, patch) => request(`/tasks/${id}`, { method: 'PATCH', body: patch }),

  deleteTask: (id) => request(`/tasks/${id}`, { method: 'DELETE' }),

  addAttachments: (id, files) => {
    const form = new FormData();
    for (const file of files) form.append('attachments', file);
    return request(`/tasks/${id}/attachments`, { method: 'POST', body: form });
  },

  deleteAttachment: (taskId, attachmentId) =>
    request(`/tasks/${taskId}/attachments/${attachmentId}`, { method: 'DELETE' }),

  // Обычная ссылка: скачивание файла браузер делает сам.
  attachmentUrl: (taskId, attachmentId) => `${BASE_URL}/tasks/${taskId}/attachments/${attachmentId}`
};
