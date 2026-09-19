import { useEffect, useRef, useState } from 'react';

import { formatSize } from '../lib/format';

const EMPTY = { title: '', description: '', status: 'todo', dueDate: '' };

/**
 * Форма задачи — общая для создания и редактирования.
 *
 * withFiles=true (создание): форма отправляется как multipart/form-data вместе
 * с файлами. withFiles=false (редактирование): уходит чистый JSON, а вложения
 * живут своим подресурсом /api/tasks/:id/attachments.
 *
 * fieldErrors — ошибки от сервера (error.fields), localErrors — быстрая проверка
 * файлов на клиенте. Решающее слово всегда за серверной валидацией.
 */
export default function TaskForm({
  formId,
  statuses,
  limits,
  initial,
  submitLabel = 'Сохранить',
  busy = false,
  withFiles = true,
  fieldErrors = {},
  onSubmit,
  onCancel,
  resetAfterSubmit = false
}) {
  const [values, setValues] = useState({ ...EMPTY, ...initial });
  const [files, setFiles] = useState([]);
  const [localErrors, setLocalErrors] = useState({});
  const fileInputRef = useRef(null);

  useEffect(() => {
    setValues({ ...EMPTY, ...initial });
  }, [initial]);

  const change = (field) => (event) => {
    setValues((previous) => ({ ...previous, [field]: event.target.value }));
  };

  const changeFiles = (event) => {
    const selected = Array.from(event.target.files || []);
    const errors = {};

    if (limits && selected.length > limits.maxFiles) {
      errors.attachments = `За один раз можно приложить не более ${limits.maxFiles} файлов`;
    } else if (limits) {
      const tooBig = selected.find((file) => file.size > limits.maxFileSize);
      if (tooBig) errors.attachments = `Файл «${tooBig.name}» больше ${formatSize(limits.maxFileSize)}`;
    }

    setLocalErrors(errors);
    setFiles(errors.attachments ? [] : selected);
  };

  const clearFiles = () => {
    setFiles([]);
    setLocalErrors({});
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const submit = async (event) => {
    // Страница не перезагружается: данные уходят на сервер через fetch.
    event.preventDefault();
    if (busy || localErrors.attachments) return;

    const saved = await onSubmit(values, files);
    if (saved) {
      clearFiles();
      if (resetAfterSubmit) setValues({ ...EMPTY });
    }
  };

  const errorOf = (field) => localErrors[field] || fieldErrors[field];
  const fieldId = (name) => `${formId}-${name}`;

  return (
    <form className="task-form" onSubmit={submit} noValidate>
      <div className="field">
        <label htmlFor={fieldId('title')}>
          Название <span className="req">*</span>
        </label>
        <input
          id={fieldId('title')}
          type="text"
          value={values.title}
          onChange={change('title')}
          maxLength={limits?.titleMax}
          placeholder="Например: подготовить отчёт по лабораторной"
          aria-invalid={Boolean(errorOf('title'))}
        />
        {errorOf('title') && <p className="field__error">{errorOf('title')}</p>}
      </div>

      <div className="field">
        <label htmlFor={fieldId('description')}>Описание</label>
        <textarea
          id={fieldId('description')}
          rows={3}
          value={values.description}
          onChange={change('description')}
          maxLength={limits?.descriptionMax}
          placeholder="Детали, ссылки, критерии готовности"
          aria-invalid={Boolean(errorOf('description'))}
        />
        {errorOf('description') && <p className="field__error">{errorOf('description')}</p>}
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor={fieldId('status')}>Статус</label>
          <select id={fieldId('status')} value={values.status} onChange={change('status')}>
            {statuses.map((status) => (
              <option key={status.value} value={status.value}>
                {status.label}
              </option>
            ))}
          </select>
          {errorOf('status') && <p className="field__error">{errorOf('status')}</p>}
        </div>

        <div className="field">
          <label htmlFor={fieldId('dueDate')}>Ожидаемая дата завершения</label>
          <input
            id={fieldId('dueDate')}
            type="date"
            value={values.dueDate || ''}
            onChange={change('dueDate')}
            aria-invalid={Boolean(errorOf('dueDate'))}
          />
          {errorOf('dueDate') && <p className="field__error">{errorOf('dueDate')}</p>}
        </div>

        {withFiles && (
          <div className="field">
            <label htmlFor={fieldId('attachments')}>Вложения</label>
            <input
              id={fieldId('attachments')}
              ref={fileInputRef}
              type="file"
              multiple
              onChange={changeFiles}
            />
            <p className="field__hint">
              {limits
                ? `До ${limits.maxFiles} файлов, каждый до ${formatSize(limits.maxFileSize)}`
                : 'Можно приложить несколько файлов'}
            </p>
            {errorOf('attachments') && <p className="field__error">{errorOf('attachments')}</p>}
          </div>
        )}
      </div>

      <div className="form-actions">
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? 'Сохраняю…' : submitLabel}
        </button>
        {onCancel && (
          <button className="btn btn--ghost" type="button" onClick={onCancel} disabled={busy}>
            Отмена
          </button>
        )}
        {withFiles && files.length > 0 && (
          <span className="form-actions__hint">
            Выбрано файлов: {files.length}{' '}
            <button className="link-button" type="button" onClick={clearFiles}>
              очистить
            </button>
          </span>
        )}
      </div>
    </form>
  );
}
