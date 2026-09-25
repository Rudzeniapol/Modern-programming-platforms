import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { ApiError, api } from '../api';
import Filters from '../components/Filters';
import Notice from '../components/Notice';
import TaskCard from '../components/TaskCard';
import TaskForm from '../components/TaskForm';
import { can, canOnTask } from '../lib/permissions';

const DEFAULT_FILTER = { status: 'all', sort: 'dueDate', scope: 'all', q: '' };
const EMPTY_COUNTS = { all: 0, todo: 0, in_progress: 0, done: 0 };
const SEARCH_DEBOUNCE_MS = 300;

export default function TasksPage({ meta, user, showNotice }) {
  const [tasks, setTasks] = useState([]);
  const [counts, setCounts] = useState(EMPTY_COUNTS);

  const [filter, setFilter] = useState(DEFAULT_FILTER);
  const [debouncedQuery, setDebouncedQuery] = useState('');

  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(null);

  const [creating, setCreating] = useState(false);
  const [createErrors, setCreateErrors] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [editErrors, setEditErrors] = useState({});
  const [busyId, setBusyId] = useState(null);

  // Поиск не должен слать запрос на каждую нажатую клавишу.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(filter.q), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [filter.q]);

  const activeFilter = useMemo(
    () => ({ status: filter.status, sort: filter.sort, scope: filter.scope, q: debouncedQuery }),
    [filter.status, filter.sort, filter.scope, debouncedQuery]
  );

  // Актуальный фильтр нужен и обработчикам, которые перезагружают список
  // после сохранения, поэтому держим его в ref.
  const filterRef = useRef(activeFilter);

  const loadTasks = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.listTasks(filterRef.current);
      setTasks(data.items);
      setCounts(data.counts);
      setListError(null);
    } catch (error) {
      setListError(error.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    filterRef.current = activeFilter;
    loadTasks();
  }, [activeFilter, loadTasks]);

  /**
   * Общая обёртка над изменяющими запросами: блокирует карточку на время
   * запроса, показывает сообщение и раскладывает ошибки полей по формам.
   */
  const run = useCallback(
    async (taskId, action, successText, setFieldErrors) => {
      setBusyId(taskId);
      if (setFieldErrors) setFieldErrors({});
      try {
        await action();
        await loadTasks();
        showNotice('success', successText);
        return true;
      } catch (error) {
        const fields = error instanceof ApiError ? error.fields : {};
        if (setFieldErrors) setFieldErrors(fields);
        showNotice('error', error.message);
        return false;
      } finally {
        setBusyId(null);
      }
    },
    [loadTasks, showNotice]
  );

  const handleCreate = async (values, files) => {
    setCreating(true);
    const created = await run(
      null,
      () => api.createTask(values, files),
      'Задача добавлена.',
      setCreateErrors
    );
    setCreating(false);
    return created;
  };

  const handleSave = async (id, values) => {
    const saved = await run(id, () => api.replaceTask(id, values), 'Изменения сохранены.', setEditErrors);
    if (saved) setEditingId(null);
    return saved;
  };

  const handleChangeStatus = (id, status) => run(id, () => api.patchTask(id, { status }), 'Статус обновлён.');

  const handleDelete = (task) => {
    if (!window.confirm(`Удалить задачу «${task.title}» вместе с вложениями?`)) return undefined;
    return run(task.id, () => api.deleteTask(task.id), 'Задача удалена.');
  };

  const handleUploadAttachments = (id, files) =>
    run(id, () => api.addAttachments(id, files), `Файлов загружено: ${files.length}.`);

  const handleDeleteAttachment = (taskId, attachmentId, name) => {
    if (!window.confirm(`Удалить файл «${name}»?`)) return undefined;
    return run(taskId, () => api.deleteAttachment(taskId, attachmentId), 'Файл удалён.');
  };

  const handleDownloadAttachment = (taskId, attachment) =>
    api.downloadAttachment(taskId, attachment).catch((error) => showNotice('error', error.message));

  const changeFilter = (patch) => setFilter((previous) => ({ ...previous, ...patch }));

  const resetFilter = () => {
    setFilter(DEFAULT_FILTER);
    setDebouncedQuery('');
  };

  const startEdit = (id) => {
    setEditErrors({});
    setEditingId(id);
  };

  const seesAll = can(user, 'tasks:read:any');

  return (
    <>
      {can(user, 'tasks:create') && (
        <section className="panel">
          <h2 className="panel__title">Новая задача</h2>
          <TaskForm
            formId="create"
            statuses={meta.statuses}
            limits={meta.limits}
            submitLabel="Добавить задачу"
            busy={creating}
            fieldErrors={createErrors}
            onSubmit={handleCreate}
            resetAfterSubmit
          />
        </section>
      )}

      <section className="panel">
        <Filters
          statuses={meta.statuses}
          filter={filter}
          counts={counts}
          showScope={seesAll}
          onChange={changeFilter}
          onReset={resetFilter}
        />

        {listError && <Notice notice={{ type: 'error', text: listError }} />}

        {loading && <p className="empty">Загружаю задачи…</p>}

        {!loading && !listError && tasks.length === 0 && (
          <p className="empty">
            {counts.all
              ? 'Под выбранный фильтр не подходит ни одна задача.'
              : 'Задач пока нет — добавьте первую с помощью формы выше.'}
          </p>
        )}

        {!loading && tasks.length > 0 && (
          <ul className="task-list">
            {tasks.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                statuses={meta.statuses}
                limits={meta.limits}
                showOwner={seesAll && task.ownerId !== user.id}
                canUpdate={canOnTask(user, 'update', task)}
                canDelete={canOnTask(user, 'delete', task)}
                editing={editingId === task.id}
                busy={busyId === task.id}
                fieldErrors={editingId === task.id ? editErrors : {}}
                onStartEdit={startEdit}
                onCancelEdit={() => setEditingId(null)}
                onSave={handleSave}
                onChangeStatus={handleChangeStatus}
                onDelete={handleDelete}
                onUploadAttachments={handleUploadAttachments}
                onDeleteAttachment={handleDeleteAttachment}
                onDownloadAttachment={handleDownloadAttachment}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
