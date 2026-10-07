/**
 * scripts/send-sequence-tests.ts
 *
 * Sends the follow-up sequences, rendered from real rows of "U.S. Conquest"
 * and "The Official UK", to test inboxes through the connected Gmail account
 * (the same account and renderer production uses). Every status gets one
 * real row per spreadsheet; each inbox receives whole 6-email sequences.
 *
 * Usage (from apps/api, root .env loaded):
 *   npx tsx scripts/send-sequence-tests.ts --to=<file with one address per line> --out=<report.json> [--dry-run]
 *
 * Recipients come from a file so test addresses never end up in the repo.
 */

import { readFileSync, writeFileSync } from 'fs';

import { PrismaClient } from '@prisma/client';
import { pickFollowUpTemplate, TAG_EMAIL_TEMPLATE, type CallStatusTag } from '@pstn-twilio/shared';

import { decryptSecret } from '../src/common/secret-box';
import { loadSequence, renderSequenceEmail, type Region } from '../src/sheets/follow-up-sequences';
import {
  buildSequenceVars,
  parseStatusCell,
  regionFor,
  rowRecord,
  type FollowUpContext,
  type RowData,
} from '../src/sheets/follow-up-vars';
import { encodeMessage } from '../src/sheets/gmail.service';
import { resolveTimeZone } from '../src/sheets/sheets-timezone.service';
import { nationalDigits, normalizeHeader } from '../src/sheets/sheets.util';

const US_SHEET = process.env.US_CONQUEST_SHEET_ID ?? '1hEen_n9M27n5bjyXpsnaHXpvG7S5eHHmPl6HG2LhRnM';
const UK_SHEET = process.env.UK_OFFICIAL_SHEET_ID ?? '1RmfJeS9wj82LwvpNa5VdKRNwyQChzVyGwzLx31jP3ts';
const SEND_GAP_MS = 3000;

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function accessToken(prisma: PrismaClient): Promise<{ token: string; from: string }> {
  const conn = await prisma.googleSheetsConnection.findFirst({ orderBy: { updatedAt: 'desc' } });
  if (!conn) throw new Error('No Google Sheets & Gmail connection.');
  if (!conn.scopes.includes('gmail.send'))
    throw new Error('The connection has no gmail.send scope.');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLOUD_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLOUD_CLIENT_SECRET!,
      grant_type: 'refresh_token',
      refresh_token: decryptSecret(conn.refreshTokenEncrypted, process.env.TOKEN_ENCRYPTION_KEY!),
    }),
  });
  const body = (await res.json()) as { access_token?: string; error?: string };
  if (!body.access_token) throw new Error(`Token refresh failed: ${body.error ?? res.status}`);
  return { token: body.access_token, from: conn.googleEmail ?? '(connected account)' };
}

async function google<T>(token: string, url: string): Promise<T> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`Google API: ${body.error?.message ?? res.status}`);
  return body;
}

interface Lead {
  region: Region;
  spreadsheetId: string;
  sheetTitle: string;
  row: RowData;
  tags: CallStatusTag[];
  hasNote: boolean;
}

async function statusRows(token: string, spreadsheetId: string, region: Region): Promise<Lead[]> {
  const meta = await google<{ sheets: Array<{ properties: { title: string } }> }>(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`,
  );
  const titles = meta.sheets.map((s) => s.properties.title);
  const ranges = titles
    .map((t) => `ranges=${encodeURIComponent(`'${t.replace(/'/g, "''")}'`)}`)
    .join('&');
  const data = await google<{ valueRanges: Array<{ range: string; values?: string[][] }> }>(
    token,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet?${ranges}`,
  );
  const leads: Lead[] = [];
  data.valueRanges.forEach((range, i) => {
    const rows = range.values ?? [];
    const headers = (rows[0] ?? []).map(normalizeHeader);
    for (const raw of rows.slice(1)) {
      const row = rowRecord(headers, raw);
      if (!row.status || !row.phonenumber) continue;
      const parsed = parseStatusCell(row.status);
      leads.push({
        region,
        spreadsheetId,
        sheetTitle: titles[i]!,
        row,
        tags: parsed.tags as CallStatusTag[],
        hasNote: Boolean(parsed.note),
      });
    }
  });
  return leads;
}

function e164(raw: string): string {
  const national = nationalDigits(raw) ?? '';
  if (national.startsWith('0')) return `+44${national.slice(1)}`;
  return national ? `+1${national}` : raw;
}

async function main(): Promise<void> {
  const toFile = arg('to');
  const outFile = arg('out');
  const dryRun = process.argv.includes('--dry-run');
  if (!toFile || !outFile)
    throw new Error('Usage: --to=<recipients file> --out=<report.json> [--dry-run]');
  const recipients = readFileSync(toFile, 'utf8')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
  if (recipients.length === 0) throw new Error('No recipients in the file.');

  const prisma = new PrismaClient();
  try {
    const { token, from } = await accessToken(prisma);
    const leads = [
      ...(await statusRows(token, US_SHEET, 'US')),
      ...(await statusRows(token, UK_SHEET, 'UK')),
    ];
    const pushes = await prisma.sheetsPushLog.findMany({
      where: { spreadsheetId: { in: [US_SHEET, UK_SHEET] } },
      orderBy: { createdAt: 'desc' },
      select: {
        spreadsheetId: true,
        destinationE164: true,
        callEndedAt: true,
        timeZone: true,
        callerE164: true,
      },
    });

    const keys = [...new Set(Object.values(TAG_EMAIL_TEMPLATE))] as string[];
    const sequences: Array<{
      region: Region;
      key: string;
      school: string;
      emails: Array<{ step: number; subject: string; body: string }>;
    }> = [];
    const fallbackTurn: Record<Region, number> = { US: 0, UK: 0 };
    for (const key of keys) {
      for (const region of ['US', 'UK'] as const) {
        const pool = leads.filter((l) => l.region === region);
        // A row with this very status first. Otherwise another called school,
        // a different one each time, without its note (that note was about
        // a different outcome).
        const exact = pool.filter((l) => pickFollowUpTemplate(l.tags).template === key);
        const turn = fallbackTurn[region]++;
        const others = [...pool.slice(turn % Math.max(1, pool.length)), ...pool];
        const candidates = [...exact.filter((l) => l.hasNote), ...exact, ...others];
        for (const lead of candidates) {
          const isExact = exact.includes(lead);
          const dest = e164(lead.row.phonenumber!);
          const push = pushes.find(
            (p) => p.spreadsheetId === lead.spreadsheetId && p.destinationE164 === dest,
          );
          const status = parseStatusCell(lead.row.status!);
          const cellValue = isExact
            ? lead.row.status!
            : `${status.tags.join(', ')}, from: ${status.from ?? ''}, time: ${status.time ?? ''}`;
          const ctx: FollowUpContext = {
            spreadsheetId: lead.spreadsheetId,
            sheetTitle: lead.sheetTitle,
            destinationE164: dest,
            callerE164: push?.callerE164 ?? (region === 'UK' ? '+442045726501' : '+18776524532'),
            cellValue,
            customNote: isExact ? status.note : null,
            schoolName: lead.row.title ?? null,
            callEndedAt: push?.callEndedAt ?? new Date(),
            timeZone:
              push?.timeZone ??
              (region === 'UK'
                ? 'Europe/London'
                : resolveTimeZone(lead.row.address ?? '', '+1').timeZone),
          };
          const vars = buildSequenceVars(
            lead.row,
            ctx,
            regionFor(ctx, { usSheetId: US_SHEET, ukSheetId: UK_SHEET }),
          );
          const emails = loadSequence(key, region).map((email) => renderSequenceEmail(email, vars));
          if (emails.some((e) => !e)) continue;
          sequences.push({
            region,
            key,
            school: vars.school_name,
            emails: emails.map((e, i) => ({ step: i + 1, ...e! })),
          });
          break;
        }
      }
    }

    // Each inbox gets whole sequences; the extras go to the first inboxes.
    const plan = sequences.map((seq, i) => ({ to: recipients[i % recipients.length]!, ...seq }));
    const report: Array<Record<string, unknown>> = [];
    console.log(
      `${plan.length} sequences, ${plan.length * 6} emails, from ${from}${dryRun ? ' (dry run)' : ''}`,
    );
    for (const item of plan) {
      for (const email of item.emails) {
        const entry: Record<string, unknown> = {
          to: item.to,
          region: item.region,
          sequence: item.key,
          step: email.step,
          school: item.school,
          subject: email.subject,
          body: email.body,
        };
        if (!dryRun) {
          const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw: encodeMessage(item.to, email.subject, email.body) }),
          });
          const body = (await res.json()) as { id?: string; error?: { message?: string } };
          entry.gmailId = body.id ?? null;
          entry.error = res.ok ? null : (body.error?.message ?? `HTTP ${res.status}`);
          console.log(
            `${res.ok ? 'sent' : 'FAILED'} ${item.region} ${item.key} #${email.step} → ${item.to}${res.ok ? '' : `: ${entry.error}`}`,
          );
          await new Promise((r) => setTimeout(r, SEND_GAP_MS));
        }
        report.push(entry);
      }
    }
    writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log(`Report: ${outFile}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
