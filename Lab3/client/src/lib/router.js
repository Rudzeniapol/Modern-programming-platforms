import { useCallback, useEffect, useState } from 'react';

// Минимальный маршрутизатор на History API: страница не перезагружается,
// а адреса вида /reset-password?token=… из письма открываются напрямую
// (nginx на любой путь отдаёт index.html).
export function useRoute() {
  const read = () => ({ path: window.location.pathname, query: new URLSearchParams(window.location.search) });
  const [route, setRoute] = useState(read);

  useEffect(() => {
    const onPop = () => setRoute(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((to, { replace = false } = {}) => {
    window.history[replace ? 'replaceState' : 'pushState'](null, '', to);
    setRoute(read());
  }, []);

  return [route, navigate];
}
