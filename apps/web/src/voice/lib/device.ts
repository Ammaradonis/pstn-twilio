// This browser or installed app as one of the user's devices, plus the
// settings that belong to the device rather than the account (ringtone,
// vibration).

import { useSyncExternalStore } from 'react';

import type { RingtoneId } from './ringtone';

const DEVICE_ID_KEY = 'voice.deviceId';
const PREFS_KEY = 'voice.devicePrefs';

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode: keep for this session only */
  }
}

let sessionDeviceId: string | null = null;

export function deviceId(): string {
  const stored = safeGet(DEVICE_ID_KEY);
  if (stored) return stored;
  sessionDeviceId ??=
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  safeSet(DEVICE_ID_KEY, sessionDeviceId);
  return sessionDeviceId;
}

type NavigatorWithUaData = Navigator & {
  userAgentData?: { platform?: string; mobile?: boolean };
  standalone?: boolean;
};

/** "Android", "iPhone", "Windows"… Android in "desktop site" mode still says Android. */
export function devicePlatform(): string {
  const nav = navigator as NavigatorWithUaData;
  const ua = nav.userAgent;
  const hinted = nav.userAgentData?.platform;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua) || hinted === 'Android') return 'Android';
  if (/Linux/.test(ua) && nav.maxTouchPoints > 0) return 'Android';
  if (/CrOS/.test(ua)) return 'Chromebook';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Linux/.test(ua)) return 'Linux';
  return hinted || 'Web';
}

function browserName(): string {
  const ua = navigator.userAgent;
  if (/SamsungBrowser/.test(ua)) return 'Samsung Internet';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/CriOS|Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

export function isStandaloneApp(): boolean {
  const nav = navigator as NavigatorWithUaData;
  return (
    nav.standalone === true ||
    (typeof window.matchMedia === 'function' &&
      window.matchMedia('(display-mode: standalone)').matches)
  );
}

/** A readable default name, e.g. "Android app" or "Windows · Edge". */
export function defaultDeviceName(): string {
  const platform = devicePlatform();
  return isStandaloneApp() ? `${platform} app` : `${platform} · ${browserName()}`;
}

export function isIos(): boolean {
  const platform = devicePlatform();
  return platform === 'iPhone' || platform === 'iPad';
}

export interface DevicePrefs {
  ringtone: RingtoneId;
  vibrate: boolean;
  // Show a system notification when a call rings while the app is in the background.
  callNotifications: boolean;
}

const DEFAULT_PREFS: DevicePrefs = { ringtone: 'voice', vibrate: true, callNotifications: true };
const listeners = new Set<() => void>();
let prefsCache: DevicePrefs | null = null;

export function getDevicePrefs(): DevicePrefs {
  if (prefsCache) return prefsCache;
  try {
    const raw = safeGet(PREFS_KEY);
    prefsCache = { ...DEFAULT_PREFS, ...(raw ? (JSON.parse(raw) as Partial<DevicePrefs>) : {}) };
  } catch {
    prefsCache = DEFAULT_PREFS;
  }
  return prefsCache;
}

export function setDevicePrefs(patch: Partial<DevicePrefs>): void {
  prefsCache = { ...getDevicePrefs(), ...patch };
  safeSet(PREFS_KEY, JSON.stringify(prefsCache));
  for (const listener of listeners) listener();
}

export function useDevicePrefs(): DevicePrefs {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getDevicePrefs,
    getDevicePrefs,
  );
}
