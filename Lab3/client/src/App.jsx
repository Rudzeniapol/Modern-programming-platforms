import { useCallback, useEffect, useRef, useState } from 'react';

import { api, refreshSession, setSessionLostHandler } from './api';
import Notice from './components/Notice';
import { can } from './lib/permissions';
import { useRoute } from './lib/router';
import AuthPage from './pages/AuthPage';
import SecurityPage from './pages/SecurityPage';
import TasksPage from './pages/TasksPage';
import UsersPage from './pages/UsersPage';

const AUTH_ROUTES = {
  '/login': 'login',
  '/register': 'register',
  '/forgot-password': 'forgot',
  '/reset-password': 'reset'
};

export default function App() {
  const [meta, setMeta] = useState(null);
  const [bootError, setBootError] = useState(null);
  // undefined — ещё выясняем, есть ли сессия; null — гость; объект — вошедший пользователь.
  const [user, setUser] = useState(undefined);
  const [notice, setNotice] = useState(null);
  const [route, navigate] = useRoute();

  const noticeTimer = useRef(null);

  const showNotice = useCallback((type, text) => {
    clearTimeout(noticeTimer.current);
    setNotice({ type, text });
    // Сообщение об успехе прячем само, ошибку оставляем дольше на экране.
    noticeTimer.current = setTimeout(() => setNotice(null), type === 'error' ? 8000 : 4000);
  }, []);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  // При загрузке страницы пробуем восстановить сессию по refresh-cookie:
  // access-токен живёт только в памяти и после перезагрузки его нет.
  useEffect(() => {
    api
      .getMeta()
      .then(setMeta)
      .catch((error) => setBootError(error.message));
    refreshSession()
      .then(setUser)
      .catch(() => setUser(null));
  }, []);

  const signOut = useCallback(
    (message, type = 'error') => {
      setUser(null);
      navigate('/login', { replace: true });
      if (message) showNotice(type, message);
    },
    [navigate, showNotice]
  );

  useEffect(() => {
    setSessionLostHandler(() => signOut('Сессия завершена или истекла. Войдите снова.'));
  }, [signOut]);

  const signedIn = (nextUser) => {
    setUser(nextUser);
    navigate('/', { replace: true });
  };

  const logout = async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
    navigate('/login', { replace: true });
  };

  if (bootError) {
    return (
      <div className="container app-loading">
        <Notice notice={{ type: 'error', text: bootError }} />
      </div>
    );
  }

  if (!meta || user === undefined) {
    return (
      <div className="container app-loading">
        <p className="empty">Загружаю приложение…</p>
      </div>
    );
  }

  // Ссылка из письма открывает смену пароля, даже если в этом браузере кто-то уже вошёл.
  const authMode = AUTH_ROUTES[route.path];
  if (!user || authMode === 'reset') {
    return (
      <>
        <div className="container">
          <Notice notice={notice} onClose={() => setNotice(null)} />
        </div>
        <AuthPage
          mode={authMode || 'login'}
          token={route.query.get('token')}
          limits={meta.limits}
          onSignedIn={signedIn}
          // Сброс пароля закрывает все сессии — в том числе ту, что открыта в этом браузере.
          onPasswordReset={() => setUser(null)}
          navigate={navigate}
        />
      </>
    );
  }

  const roleLabel = meta.roles.find((role) => role.value === user.role)?.label || user.role;
  const pages = [
    { path: '/', label: 'Задачи' },
    { path: '/security', label: 'Безопасность' },
    ...(can(user, 'users:read') ? [{ path: '/users', label: 'Пользователи' }] : [])
  ];
  const current = pages.find((page) => page.path === route.path) ? route.path : '/';

  return (
    <>
      <header className="site-header">
        <div className="container site-header__inner">
          <span className="site-header__logo">✅ Менеджер задач</span>
          <nav className="site-nav" aria-label="Разделы">
            {pages.map((page) => (
              <button
                key={page.path}
                type="button"
                className={`site-nav__link ${current === page.path ? 'is-active' : ''}`}
                aria-current={current === page.path ? 'page' : undefined}
                onClick={() => navigate(page.path)}
              >
                {page.label}
              </button>
            ))}
          </nav>
          <div className="site-header__user">
            <span className="site-header__name" title={user.email}>
              {user.name}
            </span>
            <span className={`badge badge--role-${user.role}`}>{roleLabel}</span>
            <button className="btn btn--ghost btn--small" type="button" onClick={logout}>
              Выйти
            </button>
          </div>
        </div>
      </header>

      <main className="container">
        <Notice notice={notice} onClose={() => setNotice(null)} />

        {current === '/' && <TasksPage meta={meta} user={user} showNotice={showNotice} />}
        {current === '/security' && <SecurityPage showNotice={showNotice} onSignedOut={signOut} />}
        {current === '/users' && <UsersPage meta={meta} user={user} showNotice={showNotice} />}
      </main>

      <footer className="site-footer">
        <div className="container">
          Лабораторная работа №3 · роли и временные ключи доступа · React + Express + PostgreSQL
        </div>
      </footer>
    </>
  );
}
