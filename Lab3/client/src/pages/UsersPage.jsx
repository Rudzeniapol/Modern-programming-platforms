import { useCallback, useEffect, useState } from 'react';

import { api } from '../api';
import { formatDateTime } from '../lib/format';
import { can } from '../lib/permissions';

/**
 * Пользователи системы. Менеджер видит список (users:read), администратор
 * (users:manage) меняет роли, блокирует учётные записи, снимает блокировку
 * входа после неудачных попыток и принудительно завершает сессии.
 */
export default function UsersPage({ meta, user: me, showNotice }) {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const manage = can(me, 'users:manage');

  const load = useCallback(async () => {
    try {
      setUsers((await api.listUsers()).items);
    } catch (error) {
      showNotice('error', error.message);
    } finally {
      setLoading(false);
    }
  }, [showNotice]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (id, action, successText) => {
    setBusyId(id);
    try {
      await action();
      showNotice('success', successText);
      await load();
    } catch (error) {
      showNotice('error', error.message);
    } finally {
      setBusyId(null);
    }
  };

  const roleLabel = (value) => meta.roles.find((role) => role.value === value)?.label || value;

  return (
    <section className="panel">
      <h2 className="panel__title">Пользователи</h2>

      <ul className="role-legend">
        {meta.roles.map((role) => (
          <li key={role.value}>
            <span className={`badge badge--role-${role.value}`}>{role.label}</span> {role.description}
          </li>
        ))}
      </ul>

      {loading ? (
        <p className="empty">Загружаю…</p>
      ) : (
        <div className="table-wrap">
          <table className="users-table">
            <thead>
              <tr>
                <th>Пользователь</th>
                <th>Роль</th>
                <th>Статус</th>
                <th>Сессий</th>
                {manage && <th aria-label="Действия" />}
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const self = user.id === me.id;
                const busy = busyId === user.id;
                return (
                  <tr key={user.id} className={user.isActive ? '' : 'is-disabled'}>
                    <td>
                      <div className="users-table__name">
                        {user.name}
                        {self && ' (вы)'}
                      </div>
                      <div className="users-table__email">{user.email}</div>
                    </td>
                    <td>
                      {manage && !self ? (
                        <select
                          value={user.role}
                          disabled={busy}
                          aria-label={`Роль пользователя ${user.email}`}
                          onChange={(event) =>
                            act(
                              user.id,
                              () => api.updateUser(user.id, { role: event.target.value }),
                              'Роль изменена.'
                            )
                          }
                        >
                          {meta.roles.map((role) => (
                            <option key={role.value} value={role.value}>
                              {role.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span className={`badge badge--role-${user.role}`}>{roleLabel(user.role)}</span>
                      )}
                    </td>
                    <td>
                      {!user.isActive && <span className="status status--off">Заблокирован</span>}
                      {user.isActive && user.lockedUntil && (
                        <span className="status status--warn" title="Слишком много неудачных попыток входа">
                          Вход закрыт до {formatDateTime(user.lockedUntil)}
                        </span>
                      )}
                      {user.isActive && !user.lockedUntil && (
                        <span className="status status--on">Активен</span>
                      )}
                    </td>
                    <td>{user.activeSessions}</td>
                    {manage && (
                      <td>
                        <div className="users-table__actions">
                          {user.lockedUntil && (
                            <button
                              className="btn btn--small"
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                act(user.id, () => api.unlockUser(user.id), 'Блокировка входа снята.')
                              }
                            >
                              Разблокировать вход
                            </button>
                          )}
                          {!self && user.activeSessions > 0 && (
                            <button
                              className="btn btn--ghost btn--small"
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                act(
                                  user.id,
                                  () => api.revokeUserSessions(user.id),
                                  'Сессии пользователя завершены.'
                                )
                              }
                            >
                              Завершить сессии
                            </button>
                          )}
                          {!self && (
                            <button
                              className={`btn btn--small ${user.isActive ? 'btn--danger' : ''}`}
                              type="button"
                              disabled={busy}
                              onClick={() =>
                                act(
                                  user.id,
                                  () => api.updateUser(user.id, { isActive: !user.isActive }),
                                  user.isActive ? 'Пользователь заблокирован.' : 'Пользователь разблокирован.'
                                )
                              }
                            >
                              {user.isActive ? 'Заблокировать' : 'Разблокировать'}
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
