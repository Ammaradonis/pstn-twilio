/**
 * GmailService
 *
 * Sends the follow-up cold emails from the connected Google account (the same
 * grant as Sheets, with the gmail.send scope).
 *
 * Templates are apps/api/templates/cold-email/<name>.txt: the first line is
 * "Subject: …", the rest is the body. Placeholders:
 *   {{schoolName}}  {{customNote}}  {{callerNumber}}  {{phoneNumber}}
 *   {{callDay}} (weekday of the call, their time)  {{localTime}}
 * Phone numbers are written without country codes.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

import { Injectable } from '@nestjs/common';

import { SheetsService } from './sheets.service';

// dist/main.js runs from /app in the image (templates copied to /app/templates)
// and from apps/api in development.
const TEMPLATE_DIRS = [
  join(process.cwd(), 'templates', 'cold-email'),
  join(process.cwd(), 'apps', 'api', 'templates', 'cold-email'),
  join(__dirname, '..', 'templates', 'cold-email'),
];

export type TemplateVars = Partial<
  Record<
    'schoolName' | 'customNote' | 'callerNumber' | 'phoneNumber' | 'callDay' | 'localTime',
    string
  >
>;

@Injectable()
export class GmailService {
  constructor(private readonly sheets: SheetsService) {}

  async sendFromTemplate(
    userId: string,
    to: string,
    templateName: string,
    vars: TemplateVars,
  ): Promise<void> {
    const { subject, body } = renderTemplate(loadTemplate(templateName), vars);
    const token = await this.sheets.getAccessToken(userId);
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: encodeMessage(to, subject, body) }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new Error(`Gmail send failed: ${err.error?.message ?? `HTTP ${res.status}`}`);
    }
  }
}

export function templateDir(): string | null {
  return TEMPLATE_DIRS.find((dir) => existsSync(join(dir, 'default.txt'))) ?? null;
}

export function loadTemplate(name: string): string {
  const dir = templateDir();
  if (!dir) throw new Error('Cold email templates are missing from the API build.');
  const file = join(dir, `${name}.txt`);
  return readFileSync(existsSync(file) ? file : join(dir, 'default.txt'), 'utf8');
}

export function renderTemplate(raw: string, vars: TemplateVars): { subject: string; body: string } {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const fill = (s: string) =>
    s.replace(
      /\{\{(\w+)\}\}/g,
      (_, key: string) => (vars as Record<string, string>)[key]?.trim() ?? '',
    );
  const subject = fill(lines[0]!.replace(/^Subject:\s*/i, '')).trim();
  const body = fill(lines.slice(1).join('\n'))
    // An empty placeholder on its own line leaves a gap; collapse it.
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return { subject, body };
}

// RFC 2822 message, base64url as the Gmail API wants it. The subject is
// RFC 2047-encoded so dashes and accents survive.
export function encodeMessage(to: string, subject: string, body: string): string {
  if (/[\r\n]/.test(to)) throw new Error('Invalid recipient.');
  const message = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64'),
  ].join('\r\n');
  return Buffer.from(message).toString('base64url');
}
