import { useRef, useState } from 'react';

import { api } from '../api';
import { formatDateTime, formatSize } from '../lib/format';

/**
 * Вложения задачи — отдельный подресурс REST API:
 *   POST   /api/tasks/:id/attachments        — загрузка (multipart/form-data)
 *   GET    /api/tasks/:id/attachments/:fileId — скачивание
 *   DELETE /api/tasks/:id/attachments/:fileId — удаление
 */
export default function Attachments({ task, limits, busy, onUpload, onDelete }) {
  const [files, setFiles] = useState([]);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  const reset = () => {
    setFiles([]);
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  // Быстрая проверка на клиенте, чтобы не отправлять заведомо негодные файлы.
  // Сервер проверяет те же лимиты повторно.
  const select = (event) => {
    const selected = Array.from(event.target.files || []);

    if (limits && selected.length > limits.maxFiles) {
      setError(`За один раз можно приложить не более ${limits.maxFiles} файлов`);
      setFiles([]);
      return;
    }

    const tooBig = limits && selected.find((file) => file.size > limits.maxFileSize);
    if (tooBig) {
      setError(`Файл «${tooBig.name}» больше ${formatSize(limits.maxFileSize)}`);
      setFiles([]);
      return;
    }

    setError(null);
    setFiles(selected);
  };

  const upload = async () => {
    if (!files.length) {
      setError('Сначала выберите файлы');
      return;
    }
    const uploaded = await onUpload(task.id, files);
    if (uploaded) reset();
  };

  return (
    <div className="attachments-panel">
      <h4 className="attachments-panel__title">Вложения ({task.attachments.length})</h4>

      {task.attachments.length > 0 && (
        <ul className="attachments">
          {task.attachments.map((file) => (
            <li className="attachments__item" key={file.id}>
              {/* Скачивание — обычная ссылка на ресурс API, файл отдаёт сервер */}
              <a href={api.attachmentUrl(task.id, file.id)}>📎 {file.originalName}</a>
              <span className="attachments__size">
                {formatSize(file.size)} · {formatDateTime(file.uploadedAt)}
              </span>
              <button
                className="btn btn--danger btn--small"
                type="button"
                disabled={busy}
                onClick={() => onDelete(task.id, file.id, file.originalName)}
              >
                Удалить
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="attachments-panel__upload">
        <input ref={inputRef} type="file" multiple onChange={select} aria-label="Новые вложения" />
        <button className="btn btn--small" type="button" disabled={busy || !files.length} onClick={upload}>
          Загрузить{files.length ? ` (${files.length})` : ''}
        </button>
        {files.length > 0 && (
          <button className="link-button" type="button" onClick={reset}>
            очистить
          </button>
        )}
      </div>

      {error && <p className="field__error">{error}</p>}
    </div>
  );
}
