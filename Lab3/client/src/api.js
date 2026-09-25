// Единственная точка общения с сервером.
//
// Временные ключи:
//  — access-токен (живёт минуты) хранится только в памяти вкладки и уходит
//    в заголовке Authorization: Bearer … — его не достать из localStorage при XSS;
//  — refresh-токен лежит в HttpOnly-cookie, JavaScript его не видит вовсе.
// Когда access-токен истекает, сервер отвечает 401 — клиент один раз обновляет
// пару ключей через /auth/refresh и повторяет исходный запрос.
//
// Ошибки сервер присылает в формате RFC 9457 (application/problem+json) —
// здесь любой неуспешный ответ превращается в ApiError.

const BASE_URL = import.meta.env.VITE_API_URL || '/api';

export class ApiError extends Error {
  constructor(status, message, { code, fields, retryAfter, requestId } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code || null;
    this.fields = fields || {};
    this.retryAfter = retryAfter || null;
    this.requestId = requestId || null;
  }
}

let accessToken = null;
let refreshPromise = null;
let onSessionLost = () => {};

/** App подписывается, чтобы вернуть пользователя на экран входа, когда сессия закончилась. */
export function setSessionLostHandler(handler) {
  onSessionLost = handler;
}

// Запасной текст на случай, если тело ответа не удалось разобрать (например, 502 от nginx).
const STATUS_TEXT = {
  401: 'Требуется вход в систему',
  403: 'Недостаточно прав для выполнения действия',
  404: 'Ресурс не найден',
  405: 'Действие не поддерживается',
  409: 'Конфликт с текущим состоянием данных',
  413: 'Слишком большой запрос',
  415: 'Неподдерживаемый формат данных',
  422: 'Проверьте заполнение полей',
  429: 'Слишком много запросов. Повторите позже.',
  500: 'Внутренняя ошибка сервера',
  502: 'Сервер недоступен',
  503: 'Сервис временно недоступен'
};

async function toApiError(response) {
  const text = await response.text();
  let problem = {};
  try {
    problem = text ? JSON.parse(text) : {};
  } catch {
    problem = {};
  }
  const retryAfter = Number(response.headers.get('Retry-After')) || null;
  let message = problem.detail || STATUS_TEXT[response.status] || `Сервер ответил кодом ${response.status}`;
  if (response.status >= 500 && problem.requestId) message += ` (код обращения: ${problem.requestId})`;

  return new ApiError(response.status, message, {
    code: problem.code,
    fields: problem.fields,
    retryAfter,
    requestId: problem.requestId || response.headers.get('X-Request-Id')
  });
}

async function send(path, { method = 'GET', body, auth = true } = {}) {
  const options = { method, headers: {}, credentials: 'include' };

  if (body instanceof FormData) {
    // Content-Type для multipart/form-data браузер выставляет сам —
    // вместе с boundary, который вручную не собрать.
    options.body = body;
  } else if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  if (auth && accessToken) options.headers.Authorization = `Bearer ${accessToken}`;

  try {
    return await fetch(`${BASE_URL}${path}`, options);
  } catch {
    throw new ApiError(0, 'Сервер недоступен. Проверьте соединение и повторите попытку.');
  }
}

/**
 * Обновление пары ключей. Несколько запросов, одновременно получивших 401,
 * ждут одно и то же обновление, а не шлют refresh каждый сам по себе.
 */
export function refreshSession() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const response = await send('/auth/refresh', { method: 'POST', auth: false });
      if (!response.ok) {
        accessToken = null;
        throw await toApiError(response);
      }
      const data = await response.json();
      accessToken = data.accessToken;
      return data.user;
    })().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function request(path, { raw = false, ...options } = {}) {
  let response = await send(path, options);

  // Ключ истёк или отозван — пробуем обновить и повторить запрос один раз.
  if (response.status === 401 && options.auth !== false && accessToken) {
    try {
      await refreshSession();
    } catch {
      onSessionLost();
      throw await toApiError(response);
    }
    response = await send(path, options);
    if (response.status === 401) onSessionLost();
  }

  if (!response.ok) throw await toApiError(response);
  if (raw) return response;
  if (response.status === 204) return null;

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function buildQuery(filter = {}) {
  const params = new URLSearchParams();
  if (filter.status && filter.status !== 'all') params.set('status', filter.status);
  if (filter.sort && filter.sort !== 'dueDate') params.set('sort', filter.sort);
  if (filter.scope && filter.scope !== 'all') params.set('scope', filter.scope);
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

async function signIn(path, body) {
  const data = await request(path, { method: 'POST', body, auth: false });
  accessToken = data.accessToken;
  return data.user;
}

export const api = {
  getMeta: () => request('/meta', { auth: false }),

  // --- вход и восстановление доступа ---
  login: (email, password) => signIn('/auth/login', { email, password }),
  register: (values) => signIn('/auth/register', values),
  logout: async () => {
    try {
      await request('/auth/logout', { method: 'POST' });
    } finally {
      accessToken = null;
    }
  },
  forgotPassword: (email) =>
    request('/auth/password/forgot', { method: 'POST', body: { email }, auth: false }),
  resetPassword: (token, password) =>
    request('/auth/password/reset', { method: 'POST', body: { token, password }, auth: false }),
  changePassword: (currentPassword, newPassword) =>
    request('/auth/password/change', { method: 'POST', body: { currentPassword, newPassword } }),

  // --- активные подключения ---
  listSessions: () => request('/auth/sessions'),
  revokeSession: (id) => request(`/auth/sessions/${id}`, { method: 'DELETE' }),
  revokeOtherSessions: () => request('/auth/sessions', { method: 'DELETE' }),

  // --- пользователи (менеджер / администратор) ---
  listUsers: () => request('/users'),
  updateUser: (id, patch) => request(`/users/${id}`, { method: 'PATCH', body: patch }),
  revokeUserSessions: (id) => request(`/users/${id}/sessions`, { method: 'DELETE' }),
  unlockUser: (id) => request(`/users/${id}/lock`, { method: 'DELETE' }),

  // --- задачи ---
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

  /**
   * Скачивание вложения. Обычная ссылка не подходит: браузер не приложит к ней
   * заголовок Authorization. Поэтому файл забирается через fetch и отдаётся
   * пользователю как Blob.
   */
  downloadAttachment: async (taskId, attachment) => {
    const response = await request(`/tasks/${taskId}/attachments/${attachment.id}`, { raw: true });
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = attachment.originalName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};
