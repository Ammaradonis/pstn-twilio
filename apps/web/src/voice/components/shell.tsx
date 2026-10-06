import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';

import { useVoiceDevice } from '../../hooks/use-voice-device';
import { useAuthStore } from '../../lib/auth-store';
import { useBootstrap, useUnread } from '../hooks/use-voice-data';
import { formatNumber } from '../lib/format';

import { useCalls } from './call-manager';
import { Icon, type IconName } from './icons';
import { Avatar } from './ui';

const TABS: Array<{
  to: string;
  label: string;
  icon: IconName;
  badge?: 'missedCalls' | 'messages' | 'voicemail';
}> = [
  { to: '/voice/calls', label: 'Calls', icon: 'phone', badge: 'missedCalls' },
  { to: '/voice/messages', label: 'Messages', icon: 'message', badge: 'messages' },
  { to: '/voice/voicemail', label: 'Voicemail', icon: 'voicemail', badge: 'voicemail' },
  { to: '/voice/contacts', label: 'Contacts', icon: 'person' },
];

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="absolute -right-2 -top-1 min-w-[18px] rounded-full bg-gv-red px-1 text-center text-[11px] font-medium leading-[18px] text-white">
      {count > 99 ? '99+' : count}
    </span>
  );
}

/** Floating button for the main action of the current tab. */
function Fab() {
  const location = useLocation();
  const navigate = useNavigate();
  const { openDialer } = useCalls();
  const path = location.pathname;
  if (/^\/voice\/(messages\/.+|contacts\/.+|settings|search)/.test(path)) return null;
  const config: { label: string; icon: IconName; onClick: () => void } = path.startsWith(
    '/voice/messages',
  )
    ? { label: 'Send a message', icon: 'message', onClick: () => navigate('/voice/messages/new') }
    : path.startsWith('/voice/contacts')
      ? {
          label: 'Create contact',
          icon: 'personAdd',
          onClick: () => navigate('/voice/contacts/new'),
        }
      : { label: 'Make a call', icon: 'dialpad', onClick: () => openDialer() };
  return (
    <button
      type="button"
      onClick={config.onClick}
      className="fixed bottom-[calc(env(safe-area-inset-bottom)+5rem)] right-4 z-30 flex h-14 items-center gap-3 rounded-2xl bg-gv-blue-soft px-4 text-gv-blue shadow-[0_1px_3px_rgba(60,64,67,0.3),0_4px_8px_3px_rgba(60,64,67,0.15)] hover:bg-[#d2e3fc] md:bottom-8 md:right-8"
    >
      <Icon name={config.icon} />
      <span className="text-sm font-medium">{config.label}</span>
    </button>
  );
}

function ConnectionBanner() {
  const voice = useVoiceDevice();
  const [showSlow, setShowSlow] = useState(false);
  const notReady = !voice.registered && !voice.active;
  useEffect(() => {
    if (!notReady) {
      setShowSlow(false);
      return;
    }
    // Brief reconnects (switching apps) aren't worth a banner.
    const timer = setTimeout(() => setShowSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [notReady]);
  if (voice.recoveryFailed) {
    return (
      <div className="flex items-center justify-between gap-3 bg-[#fce8e6] px-4 py-2 text-sm text-[#a50e0e]">
        <span>Calls can&apos;t ring on this device right now.</span>
        <button type="button" onClick={voice.retryConnection} className="font-medium underline">
          Reconnect
        </button>
      </div>
    );
  }
  if (!showSlow) return null;
  return (
    <div className="bg-[#fef7e0] px-4 py-2 text-sm text-[#7a5900]">
      Connecting… calls may not ring yet.
    </div>
  );
}

function Drawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: boot } = useBootstrap();
  const { logout, user } = useAuthStore();
  const number = boot?.numbers[0];
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 md:hidden">
      <button
        type="button"
        aria-label="Close menu"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <nav className="relative flex h-full w-72 flex-col bg-white pt-[env(safe-area-inset-top)] shadow-xl">
        <div className="px-6 py-5">
          <p className="text-xl text-gv-ink">Voice</p>
          {number ? (
            <p className="mt-1 text-sm text-gv-muted">{formatNumber(number.e164)}</p>
          ) : null}
          {user ? <p className="mt-0.5 truncate text-xs text-gv-muted">{user.email}</p> : null}
        </div>
        <div className="flex-1">
          {[
            ...TABS,
            { to: '/voice/settings', label: 'Settings', icon: 'settings' as IconName },
          ].map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={onClose}
              className={({ isActive }) =>
                `mr-3 flex items-center gap-5 rounded-r-full py-3 pl-6 text-sm ${
                  isActive
                    ? 'bg-gv-blue-soft font-medium text-gv-blue'
                    : 'text-gv-ink hover:bg-gv-soft'
                }`
              }
            >
              <Icon name={item.icon} className="h-5 w-5" />
              {item.label}
            </NavLink>
          ))}
        </div>
        <button
          type="button"
          onClick={() => logout()}
          className="flex items-center gap-5 px-6 py-4 text-sm text-gv-ink hover:bg-gv-soft"
        >
          <Icon name="logout" className="h-5 w-5 text-gv-muted" />
          Sign out
        </button>
      </nav>
    </div>
  );
}

function SearchBar({ onMenu }: { onMenu: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuthStore();
  const params = new URLSearchParams(location.search);
  const onSearch = location.pathname === '/voice/search';
  const [query, setQuery] = useState(onSearch ? (params.get('q') ?? '') : '');
  useEffect(() => {
    if (!onSearch) setQuery('');
  }, [onSearch]);
  return (
    <header className="sticky top-0 z-20 bg-white px-2 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] md:px-4">
      <div className="flex items-center gap-1 rounded-full bg-gv-soft pr-1 md:max-w-2xl">
        <button
          type="button"
          aria-label={onSearch ? 'Back' : 'Menu'}
          onClick={onSearch ? () => navigate(-1) : onMenu}
          className="flex h-12 w-12 items-center justify-center rounded-full text-gv-muted hover:bg-gv-line md:hidden"
        >
          <Icon name={onSearch ? 'back' : 'menu'} />
        </button>
        <span className="hidden h-12 w-12 items-center justify-center text-gv-muted md:flex">
          <Icon name="search" />
        </span>
        <input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            navigate(`/voice/search?q=${encodeURIComponent(event.target.value)}`, {
              replace: onSearch,
            });
          }}
          onFocus={() => {
            if (!onSearch) navigate('/voice/search');
          }}
          placeholder="Search contacts, messages & calls"
          aria-label="Search"
          className="h-12 min-w-0 flex-1 border-0 bg-transparent px-1 text-base text-gv-ink placeholder:text-gv-muted focus:ring-0"
        />
        <NavLink to="/voice/settings" aria-label="Settings" className="rounded-full p-1">
          <Avatar name={user?.email ?? null} seed={user?.email ?? 'me'} size="sm" />
        </NavLink>
      </div>
    </header>
  );
}

export function VoiceShell({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState(false);
  const { data: unread } = useUnread();
  return (
    <div className="flex h-full min-h-screen bg-white text-gv-ink">
      <nav className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col px-3 py-4 md:flex">
        <p className="px-4 pb-4 text-xl text-gv-muted">Voice</p>
        {[...TABS, { to: '/voice/settings', label: 'Settings', icon: 'settings' as IconName }].map(
          (item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center gap-4 rounded-full px-4 py-3 text-sm ${
                  isActive
                    ? 'bg-gv-blue-soft font-medium text-gv-blue'
                    : 'text-gv-ink hover:bg-gv-soft'
                }`
              }
            >
              <span className="relative">
                <Icon name={item.icon} className="h-5 w-5" />
                {'badge' in item && item.badge && unread ? (
                  <Badge count={unread[item.badge]} />
                ) : null}
              </span>
              {item.label}
            </NavLink>
          ),
        )}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <SearchBar onMenu={() => setMenu(true)} />
        <ConnectionBanner />
        <main className="flex-1 pb-[calc(env(safe-area-inset-bottom)+5.5rem)] md:max-w-3xl md:pb-8">
          {children}
        </main>
      </div>
      <Fab />
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-gv-line bg-white pb-[env(safe-area-inset-bottom)] md:hidden">
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-1 pb-2 pt-3 text-xs ${
                isActive ? 'font-medium text-gv-blue' : 'text-gv-muted'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={`relative flex h-8 w-14 items-center justify-center rounded-full ${
                    isActive ? 'bg-gv-blue-soft' : ''
                  }`}
                >
                  <Icon name={tab.icon} className="h-5 w-5" />
                  {tab.badge && unread ? <Badge count={unread[tab.badge]} /> : null}
                </span>
                {tab.label}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <Drawer open={menu} onClose={() => setMenu(false)} />
    </div>
  );
}
