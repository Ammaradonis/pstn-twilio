import { useState, type FormEvent } from 'react';

import { api, ApiError } from '../lib/api-client';
import { useAuthStore } from '../lib/auth-store';
import { useToast } from '../lib/toast';

export function SettingsSecurity() {
  const user = useAuthStore((s) => s.user);
  const { push } = useToast();

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const valid =
    oldPassword.length >= 8 &&
    newPassword.length >= 8 &&
    newPassword === confirmPassword &&
    newPassword !== oldPassword;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!valid) {
      setError('Passwords must be at least 8 characters and the confirmation must match.');
      return;
    }
    setSubmitting(true);
    try {
      await api.auth.changePassword(oldPassword, newPassword);
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      push({
        tone: 'success',
        title: 'Password changed',
        message: 'Your password has been updated.',
      });
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : String(err);
      setError(message);
      push({ tone: 'error', title: 'Password change failed', message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-4">
      <header>
        <h1 className="text-2xl font-semibold">Security</h1>
        <p className="mt-1 text-sm text-slate-600">
          Change your account password. Sessions are JWT-based and expire on the API side; signing
          out clears the local token.
        </p>
      </header>

      <div className="rounded border border-slate-200 bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Account</h2>
        <dl className="mt-3 space-y-1 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">Email</dt>
            <dd className="font-mono text-xs text-slate-900">{user?.email ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-500">Role</dt>
            <dd>{user?.role ?? '—'}</dd>
          </div>
        </dl>
      </div>

      <form
        onSubmit={handleSubmit}
        className="space-y-3 rounded border border-slate-200 bg-white p-4"
      >
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          Change password
        </h2>

        <label className="block text-sm">
          <span className="text-slate-700">Current password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
            minLength={8}
            required
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>

        <label className="block text-sm">
          <span className="text-slate-700">New password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={8}
            required
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>

        <label className="block text-sm">
          <span className="text-slate-700">Confirm new password</span>
          <input
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            minLength={8}
            required
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm"
          />
        </label>

        {error && (
          <p className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !valid}
          className="rounded bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
        >
          {submitting ? 'Saving…' : 'Change password'}
        </button>

        <p className="text-[11px] leading-snug text-slate-500">
          Passwords are hashed with argon2id. The API rate-limits this endpoint and writes an audit
          log entry on every successful password change.
        </p>
      </form>
    </section>
  );
}
