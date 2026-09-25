import { useCallback, useEffect, useState } from 'react';

import { ApiError, api } from '../api';
import { formatDateTime } from '../lib/format';
import { describeUserAgent } from '../lib/userAgent';

/**
 * Безопасность учётной записи: активные подключения (сессии) и смена пароля.
 * Любую сессию можно завершить — например, если забыли выйти на чужом компьютере.
 */
export default function SecurityPage({ showNotice, onSignedOut }) {
  const [sessions, setSessions] = useState([]);
  const [limit, setLimit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api.listSessions();
      setSessions(data.items);
      setLimit(data.limit);
    } catch (error) {
      showNotice('error', error.message);
    } finally {
      setLoading(false);
    }
  }, [showNotice]);

  useEffect(() => {
    load();
  }, [load]);

  const revoke = async (session) => {
    if (
      session.current &&
      !window.confirm('Это текущая сессия — после завершения потребуется войти снова. Продолжить?')
    )
      return;
    setBusy(true);
    try {
      await api.revokeSession(session.id);
      if (session.current) {
        onSignedOut('Текущая сессия завершена.', 'success');
        return;
      }
      showNotice('success', 'Сессия завершена.');
      await load();
    } catch (error) {
      showNotice('error', error.message);
    } finally {
      setBusy(false);
    }
  };

  const revokeOthers = async () => {
    setBusy(true);
    try {
      await api.revokeOtherSessions();
      showNotice('success', 'Все остальные сессии завершены.');
      await load();
    } catch (error) {
      showNotice('error', error.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Активные подключения</h2>
          {sessions.length > 1 && (
            <button
              className="btn btn--danger btn--small"
              type="button"
              disabled={busy}
              onClick={revokeOthers}
            >
              Завершить все, кроме текущей
            </button>
          )}
        </div>
        {limit && (
          <p className="field__hint">
            Одновременно допускается не более {limit} сессий — при новом входе сверх лимита самая старая
            закрывается автоматически.
          </p>
        )}

        {loading ? (
          <p className="empty">Загружаю…</p>
        ) : (
          <ul className="session-list">
            {sessions.map((session) => (
              <li key={session.id} className={`session ${session.current ? 'session--current' : ''}`}>
                <div className="session__main">
                  <strong>{describeUserAgent(session.userAgent)}</strong>
                  {session.current && <span className="badge badge--current">Текущая</span>}
                  <span className="session__meta">
                    IP {session.ip || '—'} · вход {formatDateTime(session.createdAt)} · активность{' '}
                    {formatDateTime(session.lastSeenAt)}
                  </span>
                </div>
                <button
                  className="btn btn--ghost btn--small"
                  type="button"
                  disabled={busy}
                  onClick={() => revoke(session)}
                >
                  Завершить
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ChangePassword showNotice={showNotice} onChanged={load} />
    </>
  );
}

function ChangePassword({ showNotice, onChanged }) {
  const [values, setValues] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const change = (field) => (event) =>
    setValues((previous) => ({ ...previous, [field]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    if (values.newPassword !== values.confirm) {
      setErrors({ confirm: 'Пароли не совпадают' });
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await api.changePassword(values.currentPassword, values.newPassword);
      setValues({ currentPassword: '', newPassword: '', confirm: '' });
      showNotice('success', 'Пароль изменён. Остальные сессии завершены.');
      onChanged();
    } catch (error) {
      if (error instanceof ApiError) setErrors(error.fields);
      showNotice('error', error.message);
    } finally {
      setBusy(false);
    }
  };

  const field = (name, label, autoComplete) => (
    <div className="field">
      <label htmlFor={`pw-${name}`}>{label}</label>
      <input
        id={`pw-${name}`}
        type="password"
        autoComplete={autoComplete}
        value={values[name]}
        onChange={change(name)}
        aria-invalid={Boolean(errors[name])}
      />
      {errors[name] && <p className="field__error">{errors[name]}</p>}
    </div>
  );

  return (
    <section className="panel">
      <h2 className="panel__title">Смена пароля</h2>
      <form onSubmit={submit} noValidate>
        <div className="field-row">
          {field('currentPassword', 'Текущий пароль', 'current-password')}
          {field('newPassword', 'Новый пароль', 'new-password')}
          {field('confirm', 'Повторите новый пароль', 'new-password')}
        </div>
        <div className="form-actions">
          <button className="btn btn--primary" type="submit" disabled={busy}>
            {busy ? 'Сохраняю…' : 'Сменить пароль'}
          </button>
        </div>
      </form>
    </section>
  );
}
