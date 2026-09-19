import { useMemo } from 'react';

import Attachments from './Attachments';
import TaskForm from './TaskForm';
import { formatDate, formatDateTime, isDueToday, isOverdue } from '../lib/format';

/**
 * Карточка задачи: просмотр, быстрая смена статуса (PATCH), удаление (DELETE),
 * вложения и — по кнопке «Редактировать» — форма полного обновления (PUT).
 */
export default function TaskCard({
  task,
  statuses,
  limits,
  editing,
  busy,
  fieldErrors,
  onStartEdit,
  onCancelEdit,
  onSave,
  onChangeStatus,
  onDelete,
  onUploadAttachments,
  onDeleteAttachment
}) {
  const overdue = isOverdue(task);
  const dueToday = isDueToday(task);
  const statusLabel = statuses.find((status) => status.value === task.status)?.label || task.status;

  // Ссылка на объект должна меняться только вместе с данными задачи: иначе любая
  // перерисовка карточки (например, при блокировке кнопок на время запроса)
  // сбрасывала бы то, что пользователь уже набрал в форме редактирования.
  const initialValues = useMemo(
    () => ({
      title: task.title,
      description: task.description,
      status: task.status,
      dueDate: task.dueDate || ''
    }),
    [task.title, task.description, task.status, task.dueDate]
  );

  return (
    <li className={`task task--${task.status} ${overdue ? 'task--overdue' : ''}`}>
      <div className="task__head">
        <h3 className="task__title">{task.title}</h3>
        <span className={`badge badge--${task.status}`}>{statusLabel}</span>
      </div>

      {editing ? (
        <TaskForm
          formId={`edit-${task.id}`}
          statuses={statuses}
          limits={limits}
          initial={initialValues}
          submitLabel="Сохранить"
          busy={busy}
          withFiles={false}
          fieldErrors={fieldErrors}
          onSubmit={(values) => onSave(task.id, values)}
          onCancel={onCancelEdit}
        />
      ) : (
        <>
          {task.description && <p className="task__description">{task.description}</p>}

          <p className="task__meta">
            {task.dueDate ? (
              <span className={`task__due ${overdue ? 'is-overdue' : dueToday ? 'is-today' : ''}`}>
                📅 Срок: {formatDate(task.dueDate)}
                {overdue ? ' · просрочено' : dueToday ? ' · сегодня' : ''}
              </span>
            ) : (
              <span className="task__due">📅 Срок не задан</span>
            )}
            <span className="task__created">
              Создана {formatDateTime(task.createdAt)} · изменена {formatDateTime(task.updatedAt)}
            </span>
          </p>
        </>
      )}

      <Attachments
        task={task}
        limits={limits}
        busy={busy}
        onUpload={onUploadAttachments}
        onDelete={onDeleteAttachment}
      />

      {!editing && (
        <div className="task__actions">
          <div className="status-switch">
            <span className="status-switch__label">Статус:</span>
            {statuses.map((status) => (
              <button
                key={status.value}
                type="button"
                className={`btn btn--chip ${task.status === status.value ? 'btn--chip-active' : ''}`}
                disabled={busy || task.status === status.value}
                onClick={() => onChangeStatus(task.id, status.value)}
              >
                {status.label}
              </button>
            ))}
          </div>

          <div className="task__links">
            <button
              className="btn btn--ghost"
              type="button"
              disabled={busy}
              onClick={() => onStartEdit(task.id)}
            >
              Редактировать
            </button>
            <button className="btn btn--danger" type="button" disabled={busy} onClick={() => onDelete(task)}>
              Удалить
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
