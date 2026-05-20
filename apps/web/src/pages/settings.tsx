import { Link } from 'react-router-dom';

import { useAuthStore } from '../lib/auth-store';
import { formatDate } from '../lib/format';

export function Settings() {
  const user = useAuthStore((s) => s.user);

  return (
    <section className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-slate-600">Account, Twilio config, and security.</p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Account</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Email</dt>
              <dd className="font-mono text-xs text-slate-900">{user?.email ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Role</dt>
              <dd>{user?.role ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Created</dt>
              <dd>{formatDate(user?.createdAt ?? null)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Last login</dt>
              <dd>{formatDate(user?.lastLoginAt ?? null)}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Quick links
          </h2>
          <ul className="mt-3 space-y-2 text-sm">
            <li>
              <Link to="/settings/twilio" className="text-slate-700 underline">
                Twilio configuration & developer diagnostics
              </Link>
            </li>
            <li>
              <Link to="/settings/diagnostics" className="text-slate-700 underline">
                Live diagnostics & audit log
              </Link>
            </li>
            <li>
              <Link to="/settings/security" className="text-slate-700 underline">
                Change password
              </Link>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
