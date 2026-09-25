import { useEffect, useState } from 'react';

import { ApiError, api } from '../api';
import Notice from '../components/Notice';

const TITLES = {
  login: 'Вход',
  register: 'Регистрация',
  forgot: 'Восстановление доступа',
  reset: 'Новый пароль'
};

function Field({ id, label, error, ...props }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-invalid={Boolean(error)} {...props} />
      {error && <p className="field__error">{error}</p>}
    </div>
  );
}

function formatWait(seconds) {
  if (seconds >= 60) return `${Math.ceil(seconds / 60)} мин.`;
  return `${seconds} с`;
}

/**
 * Экраны входа, регистрации и восстановления доступа по email.
 * mode: login | register | forgot | reset (reset открывается по ссылке из письма).
 */
export default function AuthPage({ mode, token, limits, onSignedIn, onPasswordReset, navigate }) {
  const [values, setValues] = useState({ email: '', name: '', password: '', confirm: '' });
  const [errors, setErrors] = useState({});
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [lockedFor, setLockedFor] = useState(0);

  // Переход между экранами сбрасывает сообщения; сообщение об успешном сбросе
  // пароля, наоборот, должно остаться на экране входа — поэтому не через эффект.
  const go = (path) => {
    setErrors({});
    setNotice(null);
    navigate(path);
  };

  // Обратный отсчёт до конца блокировки (сервер сообщил его в Retry-After).
  useEffect(() => {
    if (lockedFor <= 0) return undefined;
    const timer = setTimeout(() => setLockedFor((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [lockedFor]);

  const change = (field) => (event) =>
    setValues((previous) => ({ ...previous, [field]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;

    if ((mode === 'register' || mode === 'reset') && values.password !== values.confirm) {
      setErrors({ confirm: 'Пароли не совпадают' });
      return;
    }

    setBusy(true);
    setErrors({});
    setNotice(null);
    try {
      if (mode === 'login') {
        onSignedIn(await api.login(values.email, values.password));
      } else if (mode === 'register') {
        onSignedIn(await api.register({ email: values.email, name: values.name, password: values.password }));
      } else if (mode === 'forgot') {
        const result = await api.forgotPassword(values.email);
        setNotice({ type: 'success', text: result.message });
      } else if (mode === 'reset') {
        await api.resetPassword(token, values.password);
        onPasswordReset();
        navigate('/login', { replace: true });
        setNotice({ type: 'success', text: 'Пароль изменён. Войдите с новым паролем.' });
      }
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors(error.fields);
        if (error.status === 429 && error.retryAfter) setLockedFor(error.retryAfter);
      }
      setNotice({ type: 'error', text: error.message });
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'reset' && !token) {
    return (
      <AuthShell title={TITLES.reset}>
        <Notice
          notice={{ type: 'error', text: 'В ссылке нет токена восстановления. Запросите письмо ещё раз.' }}
        />
        <button className="link-button" type="button" onClick={() => go('/forgot-password')}>
          Запросить новую ссылку
        </button>
      </AuthShell>
    );
  }

  const passwordHint = limits ? `Не короче ${limits.passwordMin} символов, буквы и цифры` : '';

  return (
    <AuthShell title={TITLES[mode]}>
      <Notice notice={notice} />

      <form className="auth-form" onSubmit={submit} noValidate>
        {mode !== 'reset' && (
          <Field
            id="auth-email"
            label="Email"
            type="email"
            autoComplete="email"
            value={values.email}
            onChange={change('email')}
            error={errors.email}
          />
        )}

        {mode === 'register' && (
          <Field
            id="auth-name"
            label="Имя"
            type="text"
            autoComplete="name"
            value={values.name}
            onChange={change('name')}
            error={errors.name}
          />
        )}

        {mode !== 'forgot' && (
          <Field
            id="auth-password"
            label={mode === 'reset' ? 'Новый пароль' : 'Пароль'}
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={values.password}
            onChange={change('password')}
            error={errors.password}
          />
        )}
        {(mode === 'register' || mode === 'reset') && (
          <>
            <p className="field__hint auth-form__hint">{passwordHint}</p>
            <Field
              id="auth-confirm"
              label="Повторите пароль"
              type="password"
              autoComplete="new-password"
              value={values.confirm}
              onChange={change('confirm')}
              error={errors.confirm}
            />
          </>
        )}

        {mode === 'forgot' && (
          <p className="field__hint auth-form__hint">
            Пришлём ссылку для установки нового пароля. Ссылка одноразовая.
          </p>
        )}

        <button className="btn btn--primary auth-form__submit" type="submit" disabled={busy || lockedFor > 0}>
          {lockedFor > 0
            ? `Повторить через ${formatWait(lockedFor)}`
            : busy
              ? 'Подождите…'
              : {
                  login: 'Войти',
                  register: 'Зарегистрироваться',
                  forgot: 'Отправить ссылку',
                  reset: 'Сохранить пароль'
                }[mode]}
        </button>
      </form>

      <div className="auth-links">
        {mode !== 'login' && (
          <button className="link-button" type="button" onClick={() => go('/login')}>
            Уже есть аккаунт? Войти
          </button>
        )}
        {mode === 'login' && (
          <>
            <button className="link-button" type="button" onClick={() => go('/register')}>
              Регистрация
            </button>
            <button className="link-button" type="button" onClick={() => go('/forgot-password')}>
              Забыли пароль?
            </button>
          </>
        )}
      </div>
    </AuthShell>
  );
}

function AuthShell({ title, children }) {
  return (
    <div className="auth">
      <div className="auth__brand">✅ Менеджер задач</div>
      <section className="panel auth__panel">
        <h1 className="panel__title">{title}</h1>
        {children}
      </section>
    </div>
  );
}
