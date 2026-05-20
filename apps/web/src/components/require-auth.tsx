import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { api, ApiError } from '../lib/api-client';
import { useAuthStore } from '../lib/auth-store';

export function RequireAuth() {
  const location = useLocation();
  const { token, user, setUser, logout, setStatus } = useAuthStore();

  useEffect(() => {
    if (!token) return;
    if (user) return;
    setStatus('loading');
    api.auth
      .me()
      .then((u) => {
        setUser(u);
        setStatus('authenticated');
      })
      .catch((err) => {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) logout();
        else setStatus('authenticated'); // transient error — keep token, user can retry
      });
  }, [token, user, setUser, setStatus, logout]);

  if (!token) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}
