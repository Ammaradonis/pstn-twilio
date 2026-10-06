// Notifications for calls, voicemail and texts when the app is closed or in
// the background, through the voice app's service worker and Web Push.

import { env } from '../../lib/env';

import { voiceApi } from './voice-api';

export type PushState = 'unsupported' | 'needs-install' | 'default' | 'denied' | 'granted';

const SW_URL = '/voice-sw.js';
const SW_SCOPE = '/voice/';

export function pushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

function apiBaseForWorker(): string {
  return new URL(env.VITE_API_BASE_URL, window.location.origin).toString().replace(/\/$/, '');
}

export async function voiceServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(
      `${SW_URL}?api=${encodeURIComponent(apiBaseForWorker())}`,
      { scope: SW_SCOPE },
    );
  } catch {
    return null;
  }
}

function keyBytes(base64Url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const raw = atob((base64Url + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameKey(subscription: PushSubscription, publicKey: string): boolean {
  const current = subscription.options.applicationServerKey;
  if (!current) return true;
  const expected = keyBytes(publicKey);
  const actual = new Uint8Array(current);
  return actual.length === expected.length && actual.every((byte, i) => byte === expected[i]);
}

/** Make sure this device's subscription exists and the server has it. */
async function subscribe(publicKey: string, id: string): Promise<boolean> {
  const registration = await voiceServiceWorker();
  if (!registration) return false;
  await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription, publicKey)) {
    await subscription.unsubscribe().catch(() => undefined);
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(publicKey) as BufferSource,
  });
  await voiceApi.subscribePush(id, subscription.toJSON());
  return true;
}

export function currentPushState(): PushState {
  if (!pushSupported()) {
    // iPhone and iPad allow notifications only for apps added to the Home Screen.
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    return ios ? 'needs-install' : 'unsupported';
  }
  return Notification.permission === 'default' ? 'default' : Notification.permission;
}

/** Asks for permission (must be called from a tap) and subscribes. */
export async function enablePush(publicKey: string, id: string): Promise<PushState> {
  if (!pushSupported()) return currentPushState();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'default';
  const ok = await subscribe(publicKey, id).catch(() => false);
  return ok ? 'granted' : 'default';
}

/** On start: refresh the subscription when permission was already given. */
export async function syncPush(publicKey: string | null, id: string): Promise<void> {
  if (!publicKey || !pushSupported() || Notification.permission !== 'granted') return;
  await subscribe(publicKey, id).catch(() => undefined);
}

export async function disablePush(id: string): Promise<void> {
  const registration = await navigator.serviceWorker?.getRegistration(SW_SCOPE);
  const subscription = await registration?.pushManager.getSubscription();
  await subscription?.unsubscribe().catch(() => undefined);
  await voiceApi.unsubscribePush(id);
}

/** A notification shown by the page itself (the app is open but not on screen). */
export async function showLocalNotification(
  title: string,
  options: NotificationOptions & { data?: Record<string, unknown> },
): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const registration = await voiceServiceWorker();
  await registration?.showNotification(title, options).catch(() => undefined);
}

export async function closeLocalNotifications(tag: string): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration(SW_SCOPE);
  const notifications = await registration?.getNotifications({ tag });
  notifications?.forEach((notification) => notification.close());
}
