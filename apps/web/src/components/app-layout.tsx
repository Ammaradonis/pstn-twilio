import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';

import { useAuthStore } from '../lib/auth-store';

import { ConnectionStatusBar } from './connection-status';
import { NumberSwitcher } from './number-switcher';

const PRIMARY_NAV = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/numbers', label: 'Numbers' },
  { to: '/numbers/new', label: 'New number' },
];

const SECONDARY_NAV = [
  { to: '/settings', label: 'Settings' },
  { to: '/settings/twilio', label: 'Twilio config' },
  { to: '/settings/diagnostics', label: 'Diagnostics' },
  { to: '/settings/security', label: 'Security' },
];

function navClass({ isActive }: { isActive: boolean }) {
  return `block rounded px-2 py-1.5 text-sm ${
    isActive ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
  }`;
}

export function AppLayout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, logout } = useAuthStore();

  return (
    <div className="flex min-h-full flex-col bg-slate-50">
      <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-3 py-2 md:px-6">
        <button
          type="button"
          onClick={() => setMobileOpen((v) => !v)}
          className="rounded border border-slate-300 px-2 py-1 text-xs md:hidden"
          aria-label="Toggle navigation"
        >
          ☰
        </button>
        <span className="text-sm font-semibold tracking-tight">pstn-twilio</span>
        <div className="ml-2 hidden md:block">
          <NumberSwitcher />
        </div>
        <div className="ml-auto flex items-center gap-3">
          <ConnectionStatusBar />
          {user ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="hidden text-slate-600 sm:inline">{user.email}</span>
              <button
                type="button"
                onClick={() => logout()}
                className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-100"
              >
                Sign out
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <div className="flex flex-1">
        <aside
          className={`${
            mobileOpen ? 'block' : 'hidden'
          } w-full border-b border-slate-200 bg-white p-4 md:block md:w-56 md:shrink-0 md:border-b-0 md:border-r`}
        >
          <div className="mb-3 md:hidden">
            <NumberSwitcher />
          </div>
          <nav className="flex flex-col gap-1">
            {PRIMARY_NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/dashboard'}
                onClick={() => setMobileOpen(false)}
                className={navClass}
              >
                {item.label}
              </NavLink>
            ))}
            <hr className="my-2 border-slate-100" />
            {SECONDARY_NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/settings'}
                onClick={() => setMobileOpen(false)}
                className={navClass}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <p className="mt-6 text-[11px] leading-snug text-slate-500">
            WhatsApp compatibility is not guaranteed. Some VoIP, toll-free, landline, or virtual
            numbers may be unsupported by WhatsApp/Meta.
          </p>
        </aside>

        <main className="min-w-0 flex-1 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
