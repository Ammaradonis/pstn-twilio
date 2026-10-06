/* Voice app service worker: shows notifications for calls, voicemail and
 * texts pushed by the API, and opens the app when one is tapped. It has no
 * fetch handler, so it never changes how pages load. */

const API_BASE = new URL(self.location.href).searchParams.get('api') || '/api';
const ICON = '/voice-icon-192.png';
const BADGE = '/voice-badge.png';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function appWindows() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true });
}

self.addEventListener('push', (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Voice', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(handlePush(data));
});

async function handlePush(data) {
  const windows = await appWindows();
  for (const client of windows) client.postMessage({ type: 'voice-push', payload: data });

  // The app on screen already shows its own full-screen call.
  const onScreen = windows.some((client) => client.focused && client.visibilityState === 'visible');
  if (data.type === 'incoming-call' && onScreen) return;

  const incoming = data.type === 'incoming-call';
  const options = {
    body: data.body || '',
    tag: data.tag || undefined,
    renotify: Boolean(data.renotify && data.tag),
    requireInteraction: Boolean(data.requireInteraction),
    silent: Boolean(data.silent),
    icon: ICON,
    badge: BADGE,
    timestamp: Date.now(),
    data: {
      type: data.type,
      url: data.url || '/voice/calls',
      callSid: data.callSid || null,
      actionToken: data.actionToken || null,
    },
  };
  if (incoming) {
    options.vibrate = [700, 300, 700, 300, 700, 300, 700];
    options.actions = [
      { action: 'answer', title: 'Answer' },
      { action: 'decline', title: 'Decline' },
    ];
  }
  if (data.type === 'message') {
    options.actions = [{ action: 'open', title: 'Reply' }];
  }
  if (data.type === 'missed-call' || data.type === 'voicemail') {
    options.actions = [
      { action: 'open', title: data.type === 'voicemail' ? 'Listen' : 'Call back' },
    ];
  }
  await self.registration.showNotification(data.title || 'Voice', options);
}

self.addEventListener('notificationclick', (event) => {
  const data = event.notification.data || {};
  event.notification.close();

  if (event.action === 'decline') {
    event.waitUntil(decline(data));
    return;
  }
  event.waitUntil(openApp(data.url || '/voice/calls'));
});

async function decline(data) {
  if (data.actionToken) {
    try {
      await fetch(`${API_BASE}/voice-app/push-actions/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: data.actionToken }),
      });
      return;
    } catch {
      /* fall through to the open app */
    }
  }
  const windows = await appWindows();
  for (const client of windows)
    client.postMessage({ type: 'voice-action', action: 'decline', callSid: data.callSid });
}

async function openApp(path) {
  const url = new URL(path, self.location.origin);
  const windows = await appWindows();
  const existing =
    windows.find((client) => new URL(client.url).pathname.startsWith('/voice')) || windows[0];
  if (existing) {
    await existing.focus();
    existing.postMessage({ type: 'voice-open', url: url.pathname + url.search });
    return;
  }
  await self.clients.openWindow(url.href);
}
