/**
 * The phone-style app for accounts whose experience is "voice": calls,
 * messages, voicemail and contacts for one number, synced across the user's
 * devices. The console (everyone else) never loads it.
 */

import { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';

import { CallProvider, useCalls } from './components/call-manager';
import { VoiceShell } from './components/shell';
import { SnackbarProvider } from './components/ui';
import { useBootstrap, useContacts, useVoiceSync } from './hooks/use-voice-data';
import { defaultDeviceName, deviceId, devicePlatform } from './lib/device';
import { listenForInstallPrompt } from './lib/install';
import { syncPush } from './lib/push';
import { voiceApi } from './lib/voice-api';
import { CallsPage } from './pages/calls';
import { ContactDetailPage, ContactEditPage, ContactsPage } from './pages/contacts';
import { MessagesPage, NewMessagePage, ThreadPage } from './pages/messages';
import { SearchPage } from './pages/search';
import { SettingsPage } from './pages/settings';
import { VoicemailPage } from './pages/voicemail';

const CHECK_IN_MS = 60_000;

listenForInstallPrompt();

/** Point the page at the voice app's manifest so it installs as its own app. */
function useVoiceAppChrome(): void {
  useEffect(() => {
    const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const theme = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const previous = {
      manifest: manifest?.getAttribute('href'),
      theme: theme?.getAttribute('content'),
      title: document.title,
    };
    manifest?.setAttribute('href', '/voice.webmanifest');
    theme?.setAttribute('content', '#ffffff');
    document.title = 'Voice';
    return () => {
      if (previous.manifest) manifest?.setAttribute('href', previous.manifest);
      if (previous.theme) theme?.setAttribute('content', previous.theme);
      document.title = previous.title;
    };
  }, []);
}

/** Background work: live sync, device check-ins, push subscription, phone links. */
function VoiceRuntime() {
  useVoiceSync();
  useContacts();
  const { data: boot } = useBootstrap();
  const { openDialer } = useCalls();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const id = deviceId();
    const checkIn = () => {
      if (document.visibilityState !== 'visible') return;
      void voiceApi.checkIn(id, defaultDeviceName(), devicePlatform()).catch(() => undefined);
    };
    checkIn();
    const timer = setInterval(checkIn, CHECK_IN_MS);
    document.addEventListener('visibilitychange', checkIn);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', checkIn);
    };
  }, []);

  useEffect(() => {
    if (boot) void syncPush(boot.pushPublicKey, deviceId());
  }, [boot]);

  // tel: links (after "Open phone links with Voice") and the "Make a call" shortcut.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const dial = params.get('dial');
    if (dial === null) return;
    openDialer(dial.replace(/^tel:/i, '').replace(/[^\d+*#]/g, ''));
    params.delete('dial');
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  }, [location.pathname, location.search, navigate, openDialer]);

  return null;
}

export function VoiceApp() {
  useVoiceAppChrome();
  return (
    <SnackbarProvider>
      <CallProvider>
        <VoiceRuntime />
        <VoiceShell>
          <Routes>
            <Route index element={<Navigate to="calls" replace />} />
            <Route path="calls" element={<CallsPage />} />
            <Route path="messages" element={<MessagesPage />} />
            <Route path="messages/new" element={<NewMessagePage />} />
            <Route path="messages/:counterpart" element={<ThreadPage />} />
            <Route path="voicemail" element={<VoicemailPage />} />
            <Route path="contacts" element={<ContactsPage />} />
            <Route path="contacts/new" element={<ContactEditPage />} />
            <Route path="contacts/:id" element={<ContactDetailPage />} />
            <Route path="contacts/:id/edit" element={<ContactEditPage />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="*" element={<Navigate to="calls" replace />} />
          </Routes>
        </VoiceShell>
      </CallProvider>
    </SnackbarProvider>
  );
}
