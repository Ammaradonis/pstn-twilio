import { normalizeDialablePhoneNumber } from '@pstn-twilio/shared';

export function formatPhone(e164: string): string {
  const value = normalizeDialablePhoneNumber(e164) ?? e164.trim();
  if (value.startsWith('+1') && value.length === 12) {
    return `+1 (${value.slice(2, 5)}) ${value.slice(5, 8)}-${value.slice(8)}`;
  }
  // UK numbers were shown run together ("+447918547441").
  const uk = /^\+44(\d{10})$/.exec(value)?.[1];
  if (uk) {
    // London and other 2-digit area codes, then mobiles and the rest.
    if (/^2\d/.test(uk)) return `+44 ${uk.slice(0, 2)} ${uk.slice(2, 6)} ${uk.slice(6)}`;
    return `+44 ${uk.slice(0, 4)} ${uk.slice(4)}`;
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
