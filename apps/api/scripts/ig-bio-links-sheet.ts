/** Local bridge for workers/email-finder/scripts/ig_bio_links.py: appends new matches to one sheet. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { PrismaClient } from '@prisma/client';

import { decryptSecret } from '../src/common/secret-box';

const TITLE = 'Instagram bio links: jointherealworld.com / university.com';
const TAB = 'Profiles';
const HEADERS = [
  'Username',
  'Profile URL',
  'Bio link',
  'Matched prefix',
  'Full name',
  'Followers',
  'Bio',
  'Found via',
  'Checked (UTC)',
];
const SUSPECT_TAB = 'Suspected TRW';
const SUSPECT_HEADERS = [
  'Verdict',
  'Username',
  'Profile URL',
  'Bio link',
  'Link type',
  'Evidence',
  'Resolved to',
  'Full name',
  'Followers',
  'Bio',
  'Found via',
  'Checked (UTC)',
];
const base = 'https://sheets.googleapis.com/v4/spreadsheets';
const arg = (name: string) =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);

type Match = {
  username: string;
  link: string;
  target: string;
  fullName: string;
  followers: string;
  bio: string;
  source: string;
  checkedAt: string;
};

type Suspect = {
  verdict: string;
  username: string;
  link: string;
  kind: string;
  evidence: string;
  resolvedTo: string;
  fullName: string;
  followers: string;
  bio: string;
  source: string;
  checkedAt: string;
};

async function accessToken(): Promise<string> {
  const prisma = new PrismaClient();
  try {
    const connections = await prisma.googleSheetsConnection.findMany();
    const requested = arg('user');
    const conn = requested
      ? connections.find((c) => c.userId === requested)
      : connections.length === 1
        ? connections[0]
        : undefined;
    if (!conn)
      throw new Error(
        'Select a connected Google account with --user=<id> when there is not exactly one connection.',
      );
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLOUD_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLOUD_CLIENT_SECRET!,
        grant_type: 'refresh_token',
        refresh_token: decryptSecret(conn.refreshTokenEncrypted, process.env.TOKEN_ENCRYPTION_KEY!),
      }),
    });
    const auth = (await res.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !auth.access_token)
      throw new Error(
        `Google token refresh failed (${res.status}): ${auth.error ?? ''} ${auth.error_description ?? ''}`,
      );
    return auth.access_token;
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const input = arg('in');
  const statePath = arg('state');
  if (!input || !statePath) throw new Error('Usage: --in=<matches.json> --state=<sheet.json>');
  const matches = JSON.parse(readFileSync(input, 'utf8')) as Match[];
  const token = await accessToken();

  async function google<T>(path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Sheets API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
  // RAW, so a bio that starts with "=" stays text.
  const append = (values: string[][], tab = TAB) =>
    google(
      `/${spreadsheetId}/values/${encodeURIComponent(`'${tab}'!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { values },
    );

  let spreadsheetId = existsSync(statePath)
    ? (JSON.parse(readFileSync(statePath, 'utf8')) as { spreadsheetId: string }).spreadsheetId
    : '';
  if (!spreadsheetId) {
    const made = await google<{ spreadsheetId: string }>('', {
      properties: { title: TITLE },
      sheets: [{ properties: { title: TAB, gridProperties: { frozenRowCount: 1 } } }],
    });
    spreadsheetId = made.spreadsheetId;
    writeFileSync(statePath, JSON.stringify({ spreadsheetId }));
    await append([HEADERS]);
  }

  const existing = await google<{ values?: string[][] }>(`/${spreadsheetId}/values/${TAB}!A:A`);
  const have = new Set((existing.values ?? []).map((r) => r[0]));
  const fresh = matches.filter((m) => !have.has(m.username));
  if (fresh.length) {
    await append(
      fresh.map((m) => [
        m.username,
        `https://www.instagram.com/${m.username}/`,
        m.link,
        m.target,
        m.fullName,
        m.followers,
        m.bio,
        m.source,
        m.checkedAt,
      ]),
    );
  }

  let freshSuspects = 0;
  const suspectsPath = arg('suspects');
  if (suspectsPath && existsSync(suspectsPath)) {
    const suspects = JSON.parse(readFileSync(suspectsPath, 'utf8')) as Suspect[];
    const book = await google<{ sheets: Array<{ properties: { title: string } }> }>(
      `/${spreadsheetId}?fields=sheets.properties.title`,
    );
    if (!book.sheets.some((s) => s.properties.title === SUSPECT_TAB)) {
      await google(`/${spreadsheetId}:batchUpdate`, {
        requests: [
          {
            addSheet: {
              properties: { title: SUSPECT_TAB, gridProperties: { frozenRowCount: 1 } },
            },
          },
        ],
      });
      await append([SUSPECT_HEADERS], SUSPECT_TAB);
    }
    const listed = await google<{ values?: string[][] }>(
      `/${spreadsheetId}/values/${encodeURIComponent(`'${SUSPECT_TAB}'!B:D`)}`,
    );
    // One row per account and link: an account can show several links.
    const seen = new Set((listed.values ?? []).map((r) => `${r[0]}|${r[2]}`));
    const newRows = suspects.filter((s) => !seen.has(`${s.username}|${s.link}`));
    freshSuspects = newRows.length;
    if (newRows.length) {
      await append(
        newRows.map((s) => [
          s.verdict,
          s.username,
          `https://www.instagram.com/${s.username}/`,
          s.link,
          s.kind,
          s.evidence,
          s.resolvedTo,
          s.fullName,
          s.followers,
          s.bio,
          s.source,
          s.checkedAt,
        ]),
        SUSPECT_TAB,
      );
    }
  }
  console.log(
    `SHEET added=${fresh.length} total=${have.size - 1 + fresh.length} suspects_added=${freshSuspects} ` +
      `url=https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
