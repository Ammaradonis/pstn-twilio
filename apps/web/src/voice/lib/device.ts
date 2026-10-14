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

export function isIphone(): boolean {
  return devicePlatform() === 'iPhone';
}

export function isChromeOnIos(): boolean {
  return isIos() && /CriOS/.test(navigator.userAgent);
}

export function isSafariOnIos(): boolean {
  return (
    isIos() && /Safari/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent)
  );
}

export function isGalaxyA36(): boolean {
  return (
    devicePlatform() === 'Android' &&
    (/SM-A366|Galaxy.*A36/i.test(navigator.userAgent) || /SM-A\d{3}/i.test(navigator.userAgent))
  );
}

/** A readable default name, e.g. "Galaxy A36 5G · Chrome" or "iPhone 18 Pro · Safari". */
export function defaultDeviceName(): string {
  const browser = browserName();
  if (isGalaxyA36()) {
    return isStandaloneApp() ? 'Galaxy A36 5G app' : `Galaxy A36 5G · ${browser}`;
  }
  if (isIphone()) {
    const isPro = hasDynamicIsland() || iosVersion() >= 18;
    const model = isPro ? 'iPhone 18 Pro' : 'iPhone';
    return isStandaloneApp() ? `${model} app` : `${model} · ${browser}`;
  }
  const platform = devicePlatform();
  return isStandaloneApp() ? `${platform} app` : `${platform} · ${browser}`;
}

export function isIos(): boolean {
  const platform = devicePlatform();
  return platform === 'iPhone' || platform === 'iPad';
}

/**
 * Returns the iOS major version number, or 0 if not on iOS.
 * Parses the UA string token "OS 18_0_0" / "OS 18_2" etc.
 */
export function iosVersion(): number {
  if (!isIos()) return 0;
  const match = /OS (\d+)_/.exec(navigator.userAgent);
  const version = match?.[1];
  return version ? parseInt(version, 10) : 0;
}

/**
 * True on iPhones that have a Dynamic Island (iPhone 14 Pro and later).
 * The Dynamic Island models all have a safe-area-inset-top of at least 59px
 * in standalone / fullscreen mode, whereas older notch phones top out at ~47px.
 * We use 55px as a conservative threshold so future models are included.
 * Falls back to false on non-iOS or when CSS env() is unavailable.
 */
export function hasDynamicIsland(): boolean {
  if (!isIos()) return false;
  try {
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;top:env(safe-area-inset-top,0px);height:0;width:0;visibility:hidden';
    document.body.appendChild(el);
    const top = parseFloat(getComputedStyle(el).top) || 0;
    document.body.removeChild(el);
    return top >= 55;
  } catch {
    return false;
  }
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
