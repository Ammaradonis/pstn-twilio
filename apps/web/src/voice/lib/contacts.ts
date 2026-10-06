// Contact sync with the device: the Contact Picker (Android Chrome), vCard
// (.vcf) files in and out, and dialer search.

import type { ContactDto } from '@pstn-twilio/shared';

import type { ContactImportItem } from './voice-api';

type ContactsManager = {
  getProperties?: () => Promise<string[]>;
  select: (
    properties: string[],
    options?: { multiple?: boolean },
  ) => Promise<Array<{ name?: string[]; tel?: string[]; email?: string[] }>>;
};

function contactsManager(): ContactsManager | null {
  const nav = navigator as Navigator & { contacts?: ContactsManager };
  return nav.contacts && typeof nav.contacts.select === 'function' ? nav.contacts : null;
}

/** Android Chrome lets the user pick contacts from the phone's address book. */
export function contactPickerSupported(): boolean {
  return typeof window !== 'undefined' && contactsManager() !== null;
}

export async function pickDeviceContacts(): Promise<ContactImportItem[]> {
  const manager = contactsManager();
  if (!manager) return [];
  const available = (await manager.getProperties?.().catch(() => null)) ?? ['name', 'tel', 'email'];
  const wanted = ['name', 'tel', 'email'].filter((p) => available.includes(p));
  const picked = await manager.select(wanted, { multiple: true });
  return picked.map((entry) => ({
    name: entry.name?.find(Boolean)?.trim() ?? '',
    email: entry.email?.find(Boolean)?.trim() || undefined,
    phones: (entry.tel ?? []).filter(Boolean).map((number) => ({ number })),
  }));
}

function decodeQuotedPrintable(value: string): string {
  const bytes: number[] = [];
  const text = value.replace(/=\r?\n/g, '');
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...new TextEncoder().encode(ch));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

const BACKSLASH = String.fromCharCode(92);

// Split on a separator that isn't escaped with a backslash ("ACME\; Inc" is one part).
function splitUnescaped(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i]!;
    if (ch === BACKSLASH && i + 1 < value.length) {
      current += ch + value[i + 1];
      i += 1;
    } else if (ch === separator) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

function unescapeValue(value: string): string {
  return value.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

const LABELS: Record<string, string> = {
  cell: 'mobile',
  mobile: 'mobile',
  iphone: 'mobile',
  home: 'home',
  work: 'work',
  main: 'work',
};

/** Reads contacts from a .vcf file (vCard 2.1, 3.0 and 4.0). */
export function parseVCards(text: string): ContactImportItem[] {
  // RFC line folding: a line starting with a space continues the previous one.
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const contacts: ContactImportItem[] = [];
  let current: (ContactImportItem & { structuredName?: string }) | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index]!;
    // A quoted-printable value continues while it ends with "=".
    while (
      /ENCODING=QUOTED-PRINTABLE/i.test(line) &&
      line.endsWith('=') &&
      index + 1 < lines.length
    ) {
      index += 1;
      line = `${line.slice(0, -1)}${lines[index]}`;
    }
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    let value = line.slice(colon + 1);
    const [rawName, ...params] = head.split(';');
    const name = (rawName ?? '').replace(/^item\d+\./i, '').toUpperCase();
    const paramText = params.join(';');
    if (/ENCODING=QUOTED-PRINTABLE/i.test(paramText)) value = decodeQuotedPrintable(value);

    if (name === 'BEGIN' && value.trim().toUpperCase() === 'VCARD') {
      current = { name: '', phones: [] };
    } else if (name === 'END' && value.trim().toUpperCase() === 'VCARD') {
      if (current) {
        const display = current.name || current.structuredName || '';
        contacts.push({
          name: display,
          phones: current.phones,
          ...(current.email ? { email: current.email } : {}),
          ...(current.company ? { company: current.company } : {}),
        });
      }
      current = null;
    } else if (current) {
      if (name === 'FN') {
        current.name = unescapeValue(value).trim();
      } else if (name === 'N') {
        const [family = '', given = '', middle = '', prefix = '', suffix = ''] = splitUnescaped(
          value,
          ';',
        ).map((part) => unescapeValue(part).trim());
        current.structuredName = [prefix, given, middle, family, suffix].filter(Boolean).join(' ');
      } else if (name === 'TEL') {
        const number = value.replace(/^tel:/i, '').trim();
        const types = (paramText.match(/(?:TYPE=)?([A-Za-z]+)/g) ?? [])
          .map((t) => t.replace(/^TYPE=/i, '').toLowerCase())
          .flatMap((t) => t.split(','));
        const label = types.map((t) => LABELS[t]).find(Boolean);
        if (number) current.phones.push({ number, ...(label ? { label } : {}) });
      } else if (name === 'EMAIL' && !current.email) {
        current.email = value.trim();
      } else if (name === 'ORG' && !current.company) {
        current.company = unescapeValue(splitUnescaped(value, ';')[0] ?? '').trim();
      }
    }
  }
  return contacts;
}

function escapeValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/([,;])/g, '\\$1');
}

const VCARD_TYPES: Record<string, string> = { mobile: 'CELL', home: 'HOME', work: 'WORK' };

/** Writes contacts as a .vcf file the phone's Contacts app can import. */
export function toVCards(contacts: ContactDto[]): string {
  return contacts
    .map((contact) => {
      const parts = contact.name.trim().split(/\s+/);
      const family = parts.length > 1 ? parts[parts.length - 1]! : '';
      const given = parts.length > 1 ? parts.slice(0, -1).join(' ') : (parts[0] ?? '');
      const lines = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${escapeValue(contact.name)}`,
        `N:${escapeValue(family)};${escapeValue(given)};;;`,
        ...contact.phones.map(
          (phone) => `TEL;TYPE=${VCARD_TYPES[phone.label ?? ''] ?? 'VOICE'}:${phone.e164}`,
        ),
        ...(contact.email ? [`EMAIL;TYPE=INTERNET:${contact.email}`] : []),
        ...(contact.company ? [`ORG:${escapeValue(contact.company)}`] : []),
        ...(contact.notes ? [`NOTE:${escapeValue(contact.notes)}`] : []),
        'END:VCARD',
      ];
      return lines.join('\r\n');
    })
    .join('\r\n')
    .concat('\r\n');
}

const T9: Record<string, string> = {
  a: '2',
  b: '2',
  c: '2',
  d: '3',
  e: '3',
  f: '3',
  g: '4',
  h: '4',
  i: '4',
  j: '5',
  k: '5',
  l: '5',
  m: '6',
  n: '6',
  o: '6',
  p: '7',
  q: '7',
  r: '7',
  s: '7',
  t: '8',
  u: '8',
  v: '8',
  w: '9',
  x: '9',
  y: '9',
  z: '9',
};

export const KEYPAD_LETTERS: Record<string, string> = {
  '2': 'ABC',
  '3': 'DEF',
  '4': 'GHI',
  '5': 'JKL',
  '6': 'MNO',
  '7': 'PQRS',
  '8': 'TUV',
  '9': 'WXYZ',
  '0': '+',
};

function t9(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/\s+/)
    .map((word) => [...word].map((ch) => T9[ch] ?? '').join(''))
    .join(' ');
}

/**
 * Contacts matching what was typed: digits match the number anywhere or the
 * start of a name word on the keypad letters (526 finds "Jane"); letters
 * match the name.
 */
export function searchContacts(contacts: ContactDto[], query: string, limit = 8): ContactDto[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const digits = q.replace(/\D/g, '');
  const isDial = /^[\d+*#()\-\s.]+$/.test(q);
  const scored: Array<{ contact: ContactDto; score: number }> = [];
  for (const contact of contacts) {
    let score = 0;
    if (isDial && digits) {
      if (contact.phones.some((p) => p.e164.replace(/\D/g, '').includes(digits))) score = 2;
      else if (
        t9(contact.name)
          .split(' ')
          .some((word) => word.startsWith(digits))
      )
        score = 1;
    } else {
      const name = contact.name.toLowerCase();
      if (name.startsWith(q)) score = 3;
      else if (name.split(/\s+/).some((word) => word.startsWith(q))) score = 2;
      else if (name.includes(q) || contact.company?.toLowerCase().includes(q)) score = 1;
    }
    if (score > 0) scored.push({ contact, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.contact.name.localeCompare(b.contact.name))
    .slice(0, limit)
    .map((entry) => entry.contact);
}

export function downloadFile(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Share the .vcf to the phone's Contacts app when the browser can share files. */
export async function shareOrDownloadVCard(
  contacts: ContactDto[],
): Promise<'shared' | 'downloaded'> {
  const text = toVCards(contacts);
  const filename =
    contacts.length === 1 ? `${contacts[0]!.name || 'contact'}.vcf` : 'voice-contacts.vcf';
  const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
  if (typeof File !== 'undefined' && nav.canShare) {
    const file = new File([text], filename, { type: 'text/vcard' });
    if (nav.canShare({ files: [file] })) {
      try {
        await nav.share({ files: [file], title: 'Contacts' });
        return 'shared';
      } catch (err) {
        if ((err as Error).name === 'AbortError') return 'shared';
      }
    }
  }
  downloadFile(filename, text, 'text/vcard');
  return 'downloaded';
}
