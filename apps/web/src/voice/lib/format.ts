// Display helpers for the voice app. Dates and times use the device's own
// time zone and locale, like the phone's dialer does.

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** "(415) 555-0100" for North American numbers, "+44 20 4572 6501" style otherwise. */
export function formatNumber(e164: string | null | undefined): string {
  if (!e164) return 'Unknown';
  if (!/\d/.test(e164)) return 'Unknown';
  const value = e164.trim();
  const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(value);
  if (nanp) return `(${nanp[1]}) ${nanp[2]}-${nanp[3]}`;
  const uk = /^\+44(\d{10})$/.exec(value)?.[1];
  if (uk) {
    // London and other 2-digit area codes, mobiles, then the rest.
    if (/^2\d/.test(uk)) return `+44 ${uk.slice(0, 2)} ${uk.slice(2, 6)} ${uk.slice(6)}`;
    return `+44 ${uk.slice(0, 4)} ${uk.slice(4)}`;
  }
  if (/^\+\d{8,15}$/.test(value)) {
    const digits = value.slice(1);
    const cc = digits.length > 11 ? digits.slice(0, 3) : digits.slice(0, 2);
    const rest = digits.slice(cc.length).replace(/(\d{3,4})(?=\d{3,4}$)/, '$1 ');
    return `+${cc} ${rest}`;
  }
  return value;
}

/** Pretty-print what is being typed in the dialer. */
export function formatDialInput(raw: string): string {
  const digits = raw.replace(/[^\d+*#]/g, '');
  if (digits.startsWith('+') || /[*#]/.test(digits)) return digits;
  const national = digits.startsWith('1') ? digits.slice(1) : digits;
  const prefix = digits.startsWith('1') ? '1 ' : '';
  if (national.length <= 3) return prefix + national;
  if (national.length <= 6) return `${prefix}(${national.slice(0, 3)}) ${national.slice(3)}`;
  if (national.length <= 10) {
    return `${prefix}(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
  }
  return digits;
}

function startOfDay(date: Date): number {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Short time for lists: "3:42 PM" today, "Yesterday", "Mon", "Sep 12", "Sep 12, 2025". */
export function formatListTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
  if (days <= 0) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'short' });
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Section heading for a day: "Today", "Yesterday", "Monday", "September 12, 2026". */
export function formatDayHeading(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, {
    month: 'long',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function formatFullDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Group items by local day, keeping their order. */
export function groupByDay<T>(
  items: T[],
  dateOf: (item: T) => string,
): Array<{ day: string; items: T[] }> {
  const groups: Array<{ day: string; items: T[] }> = [];
  let currentKey = '';
  for (const item of items) {
    const date = new Date(dateOf(item));
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    if (key !== currentKey) {
      groups.push({ day: formatDayHeading(dateOf(item)), items: [] });
      currentKey = key;
    }
    groups[groups.length - 1]!.items.push(item);
  }
  return groups;
}

/** "0:23" / "12:05" / "1:02:09" for timers and voicemail lengths. */
export function formatTimer(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = String(s % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** "45 sec", "3 min", "1 hr 4 min" for call lengths. */
export function formatCallLength(seconds: number | null | undefined): string {
  if (!seconds || seconds < 1) return '';
  if (seconds < 60) return `${seconds} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

export function initials(name: string): string {
  const parts = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '';
  if (/^\d/.test(parts[0]!)) return '';
  const first = parts[0]![0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : '';
  return (first + last).toUpperCase();
}

const AVATAR_COLORS = [
  'bg-[#1a73e8]',
  'bg-[#d93025]',
  'bg-[#188038]',
  'bg-[#e37400]',
  'bg-[#9334e6]',
  'bg-[#007b83]',
  'bg-[#c5221f]',
  'bg-[#1967d2]',
  'bg-[#b06000]',
  'bg-[#a142f4]',
];

export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]!;
}

/** Relative "Active now" / "5 min ago" / date for device lists. */
export function formatLastSeen(iso: string, now = Date.now()): string {
  const diff = now - new Date(iso).getTime();
  if (diff < 3 * MINUTE) return 'Active now';
  if (diff < 60 * MINUTE) return `${Math.round(diff / MINUTE)} min ago`;
  if (diff < DAY) return `${Math.round(diff / (60 * MINUTE))} hr ago`;
  return formatListTime(iso);
}
