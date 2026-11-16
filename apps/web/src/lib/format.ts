import { normalizeDialablePhoneNumber } from '@pstn-twilio/shared';

export function formatPhone(e164: string): string {
  const value = normalizeDialablePhoneNumber(e164) ?? e164.trim();
  if (value.startsWith('+1') && value.length === 12) {
    return `+1 (${value.slice(2, 5)}) ${value.slice(5, 8)}-${value.slice(8)}`;
  }
  return value;
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

export function capabilityBadge(value: boolean): string {
  return value ? '✓' : '—';
}

/** 83 000 ms -> "1:23". */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
