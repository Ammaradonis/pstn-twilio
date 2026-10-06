import { useEffect, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { api, ApiError } from '../lib/api-client';
import { useAuthStore } from '../lib/auth-store';

export function RequireAuth() {
  const location = useLocation();
  const { token, user, setUser, logout, setStatus } = useAuthStore();
  const [validatedToken, setValidatedToken] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setValidatedToken(null);
      return;
    }
    let cancelled = false;
    setStatus('loading');
    api.auth
      .me()
      .then((u) => {
        if (cancelled) return;
        setUser(u);
        setStatus('authenticated');
        setValidatedToken(token);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) logout();
        else {
          setStatus('authenticated'); // transient error — keep token, user can retry
          setValidatedToken(token);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, setUser, setStatus, logout]);

  if (!token) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (validatedToken !== token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-600">
        Checking session...
      </div>
    );
  }
  // Voice app accounts only see the voice app; everyone else only the console.
  const inVoiceApp = location.pathname === '/voice' || location.pathname.startsWith('/voice/');
  if (user?.experience === 'voice' && !inVoiceApp) {
    return <Navigate to="/voice" replace />;
  }
  if (user?.experience !== 'voice' && inVoiceApp) {
    return <Navigate to="/dashboard" replace />;
  }
  return <Outlet />;
}
