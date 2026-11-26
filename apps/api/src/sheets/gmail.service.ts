/**
 * GmailService
 *
 * Sends the follow-up emails from the connected Google account (the same
 * grant as Sheets, with the gmail.send scope). The text comes from the
 * follow-up sequences (follow-up-renderer.service.ts).
 */

import { Injectable } from '@nestjs/common';

import { GMAIL_READ_SCOPE, SheetsService } from './sheets.service';
import { extractEmails } from './sheets.util';

@Injectable()
export class GmailService {
  constructor(private readonly sheets: SheetsService) {}

  /** Returns Gmail's message id. `to` may list several addresses: "a@x.com, b@y.com". */
  async send(userId: string, to: string, subject: string, body: string): Promise<string> {
    const token = await this.sheets.getAccessToken(userId);
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encodeMessage(to, subject, body) }),
    });
    const json = (await res.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new Error(`Gmail send failed: ${json.error?.message ?? `HTTP ${res.status}`}`);
    }
    return json.id ?? '';
  }

  /**
   * Whether any of `addresses` ("a@x.com, b@y.com") has written to the inbox
   * since `since`. Null when the connection can't read mail (connected before
   * reply checks existed).
   */
  async hasReplyFrom(userId: string, addresses: string, since: Date): Promise<boolean | null> {
    const from = extractEmails(addresses);
    if (from.length === 0) return false;
    if (!(await this.sheets.hasScope(userId, GMAIL_READ_SCOPE))) return null;
    const token = await this.sheets.getAccessToken(userId);
    // {a b} is Gmail search's "either of these".
    const senders =
      from.length === 1 ? `from:${from[0]}` : `{${from.map((a) => `from:${a}`).join(' ')}}`;
    const q = `${senders} after:${Math.floor(since.getTime() / 1000)}`;
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1&q=${encodeURIComponent(q)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const json = (await res.json().catch(() => ({}))) as {
      messages?: unknown[];
      error?: { message?: string };
    };
    if (!res.ok) throw new Error(`Gmail search failed: ${json.error?.message ?? res.status}`);
    return (json.messages?.length ?? 0) > 0;
  }
}

// RFC 2822 message, base64url as the Gmail API wants it. The subject is
// RFC 2047-encoded so dashes and accents survive.
// `to` is one address or several, comma-separated; each part must be exactly
// one address, so nothing else can ride along in the header.
export function encodeMessage(to: string, subject: string, body: string): string {
  if (/[\r\n]/.test(to)) throw new Error('Invalid recipient.');
  const parts = to
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const recipients = extractEmails(to);
  if (
    recipients.length === 0 ||
    parts.length !== recipients.length ||
    parts.some((part, i) => part.toLowerCase() !== recipients[i]!.toLowerCase())
  ) {
    throw new Error('Invalid recipient.');
  }
  const message = [
    `To: ${recipients.join(', ')}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64'),
  ].join('\r\n');
  return Buffer.from(message).toString('base64url');
}
