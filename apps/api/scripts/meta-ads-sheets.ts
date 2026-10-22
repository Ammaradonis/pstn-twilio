/** Local Meta prospecting bridge. Reads both workbooks; only writes verified row backgrounds. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

import { PrismaClient } from '@prisma/client';

import { decryptSecret } from '../src/common/secret-box';
import { facebookKey, nameKey } from '../src/sheets/facebook-url';

const books = [
  {
    country: 'US',
    id: process.env.US_CONQUEST_SHEET_ID ?? '1hEen_n9M27n5bjyXpsnaHXpvG7S5eHHmPl6HG2LhRnM',
  },
  {
    country: 'GB',
    id: process.env.UK_OFFICIAL_SHEET_ID ?? '1RmfJeS9wj82LwvpNa5VdKRNwyQChzVyGwzLx31jP3ts',
  },
];
const arg = (name: string) =>
  process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const prisma = new PrismaClient();
const base = 'https://sheets.googleapis.com/v4/spreadsheets/';
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
type Tab = { sheetId: number; title: string; gridProperties?: { columnCount: number } };
type Lead = {
  country: string;
  spreadsheetId: string;
  sheetId: number;
  sheetTitle: string;
  row: number;
  title: string;
  facebookUrl: string;
  cells: string[];
};
type GoogleResponse = {
  properties: { title: string };
  sheets: Array<{
    properties: Tab;
    data?: Array<{
      rowData?: Array<{ values?: Array<{ formattedValue?: string; userEnteredFormat?: unknown }> }>;
    }>;
  }>;
  values?: string[][];
};

async function main() {
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
  const auth = (await res.json()) as { access_token?: string };
  if (!res.ok || !auth.access_token) throw new Error(`Google token refresh failed (${res.status})`);
  async function google(path: string, body?: unknown): Promise<GoogleResponse> {
    const response = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${auth.access_token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Google Sheets request failed (${response.status})`);
    return response.json();
  }
  if (arg('verify-audit')) {
    const audit = JSON.parse(readFileSync(resolve(arg('verify-audit')!), 'utf8'));
    let verified = 0;
    for (const entry of audit) {
      if (entry.result !== 'colored') continue;
      const l = entry.lead;
      if (!books.some((b) => b.id === l.spreadsheetId))
        throw new Error('Unexpected workbook in audit.');
      const range = `${quote(l.sheetTitle)}!${l.row}:${l.row}`;
      const snapshot = await google(
        `${l.spreadsheetId}?ranges=${encodeURIComponent(range)}&includeGridData=true&fields=sheets(data(rowData(values(formattedValue,userEnteredFormat(backgroundColor)))))`,
      );
      const values = snapshot.sheets[0]?.data?.[0]?.rowData?.[0]?.values ?? [];
      if (
        !values.some((v) => v.formattedValue === l.title) ||
        !values.some((v) => v.formattedValue === l.facebookUrl)
      )
        throw new Error('Row identity changed since coloring.');
      for (const cell of values) {
        const color = (
          cell.userEnteredFormat as { backgroundColor?: Record<string, number> } | undefined
        )?.backgroundColor;
        if (
          !color ||
          !Object.entries(entry.color).every(
            ([k, v]) => Math.abs((color[k] ?? 0) - Number(v)) <= 1 / 255 + 0.000001,
          )
        )
          throw new Error(
            `Row color did not persist: ${JSON.stringify({ actual: cell.userEnteredFormat, expected: entry.color })}`,
          );
      }
      verified++;
    }
    console.log(JSON.stringify({ verifiedBlueRows: verified }));
    return;
  }
  const applyFile = arg('apply');
  const selectedTabs = applyFile
    ? new Set<string>(
        JSON.parse(readFileSync(resolve(applyFile), 'utf8'))
          .results.filter((r: { verified: boolean }) => r.verified)
          .map((r: { lead: Lead }) => `${r.lead.spreadsheetId}:${r.lead.sheetId}`),
      )
    : undefined;
  const output = resolve(arg('out') ?? '../../.cache/meta-ads/inventory.json');
  const leads: Lead[] = [];
  const tabs: unknown[] = [];
  for (const book of books) {
    if (selectedTabs && ![...selectedTabs].some((k) => k.startsWith(`${book.id}:`))) continue;
    const meta = await google(`${book.id}?fields=properties.title,sheets.properties`);
    for (const { properties: tab } of meta.sheets as { properties: Tab }[]) {
      if (!tab.gridProperties) continue;
      if (selectedTabs && !selectedTabs.has(`${book.id}:${tab.sheetId}`)) continue;
      const data = await google(`${book.id}/values/${encodeURIComponent(quote(tab.title))}`);
      const rows: string[][] = data.values ?? [];
      const header = (rows[0] ?? []).map((v) => String(v).trim().toLowerCase());
      const ti = header.includes('title') ? header.indexOf('title') : header.indexOf('name'),
        fi = header.indexOf('facebookurl');
      tabs.push({
        country: book.country,
        workbook: meta.properties.title,
        spreadsheetId: book.id,
        ...tab,
        headers: rows[0] ?? [],
        rows: Math.max(0, rows.length - 1),
        titleColumn: ti,
        facebookColumn: fi,
      });
      if (ti < 0) {
        console.log(JSON.stringify({ skippedTab: tab.title, headers: rows[0] ?? [] }));
        continue;
      }
      rows.slice(1).forEach((cells, index) => {
        if (cells[ti]?.trim())
          leads.push({
            country: book.country,
            spreadsheetId: book.id,
            sheetId: tab.sheetId,
            sheetTitle: tab.title,
            row: index + 2,
            title: cells[ti],
            facebookUrl: fi < 0 ? '' : (cells[fi] ?? ''),
            cells,
          });
      });
      // Remain below Google's per-user read quota across all tabs.
      await new Promise((r) => setTimeout(r, 1100));
    }
  }
  if (applyFile) {
    await applyVerified(applyFile, leads, google);
    return;
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(
    output,
    JSON.stringify({ observedAt: new Date().toISOString(), tabs, leads }, null, 2),
  );
  console.log(
    JSON.stringify({
      inventory: output,
      tabs: tabs.length,
      schools: leads.length,
      withFacebook: leads.filter((l) => l.facebookUrl).length,
    }),
  );
}

async function applyVerified(
  file: string,
  leads: Lead[],
  google: (path: string, body?: unknown) => Promise<GoogleResponse>,
) {
  const evidence = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const { start, end, includeActive, allTime } = evidence.policy ?? {};
  if (
    allTime !== true &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(start ?? '') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(end ?? '') ||
      start > end)
  )
    throw new Error('Explicit date policy required.');
  const report: unknown[] = [];
  const applied = new Set<string>();
  const blue = { red: 159 / 255, green: 197 / 255, blue: 232 / 255 };
  const auditFile = resolve('../../.cache/meta-ads', `color-audit-${Date.now()}.json`);
  for (const result of evidence.results ?? []) {
    if (result.verified !== true || !result.nameMatch || !result.urlMatch || !result.dateMatch)
      continue;
    const { lead, ad } = result;
    if (
      !books.some((b) => b.id === lead.spreadsheetId && b.country === ad.country) ||
      lead.country !== ad.country
    )
      continue;
    const key = facebookKey(lead.facebookUrl);
    if (!key || key !== facebookKey(ad.facebookUrl) || !/^\d+$/.test(ad.adId)) continue;
    if (ad.adUrl !== `https://www.facebook.com/ads/library/?id=${ad.adId}`) continue;
    if (nameKey(ad.name) !== nameKey(lead.title)) continue;
    if (!['Active', 'Inactive'].includes(ad.status)) continue;
    // Independently check the date interval instead of trusting the exported TRUE.
    if (allTime !== true) {
      const raw = String(ad.dateText).split(' · ')[0]!;
      const parts =
        ad.status === 'Active'
          ? [raw.replace(/^Started running on /, ''), ad.observedAt]
          : raw.split(' - ');
      const dates = parts.map((p: string) => new Date(p));
      if (
        !['Active', 'Inactive'].includes(ad.status) ||
        (ad.status === 'Active' && !includeActive) ||
        dates.length !== 2 ||
        dates.some((d: Date) => !Number.isFinite(d.getTime()))
      )
        continue;
      if (dates[0].toISOString().slice(0, 10) > end || dates[1].toISOString().slice(0, 10) < start)
        continue;
    }
    const matches = leads.filter(
      (l) =>
        l.spreadsheetId === lead.spreadsheetId &&
        l.sheetId === lead.sheetId &&
        l.title === lead.title &&
        l.facebookUrl === lead.facebookUrl,
    );
    if (matches.length !== 1) {
      report.push({ result: 'ambiguous_or_changed', lead });
      continue;
    }
    const current = matches[0]!;
    const rowKey = `${current.spreadsheetId}:${current.sheetId}:${current.row}`;
    if (applied.has(rowKey)) continue;
    const range = `${quote(current.sheetTitle)}!${current.row}:${current.row}`;
    const snapshot = await google(
      `${current.spreadsheetId}?ranges=${encodeURIComponent(range)}&includeGridData=true&fields=sheets(data(startRow,rowData(values(formattedValue,userEnteredFormat(backgroundColor,backgroundColorStyle)))) )`.replace(
        / /g,
        '',
      ),
    );
    const cells = snapshot.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values ?? [];
    const values = cells.map((c: { formattedValue?: string }) => c.formattedValue ?? '');
    // Recheck current row values immediately before writing; edited/sorted rows are skipped.
    if (current.cells.some((v, i) => String(v ?? '') !== values[i])) {
      report.push({ result: 'row_changed', lead: current });
      continue;
    }
    const entry = { result: 'prepared', lead: current, ad, before: snapshot, color: blue };
    report.push(entry);
    writeFileSync(auditFile, JSON.stringify(report, null, 2));
    await google(`${current.spreadsheetId}:batchUpdate`, {
      requests: [
        {
          repeatCell: {
            range: {
              sheetId: current.sheetId,
              startRowIndex: current.row - 1,
              endRowIndex: current.row,
            },
            cell: {
              userEnteredFormat: {
                backgroundColor: blue,
                backgroundColorStyle: { rgbColor: blue },
              },
            },
            fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.backgroundColorStyle',
          },
        },
      ],
    });
    entry.result = 'colored';
    applied.add(rowKey);
    writeFileSync(auditFile, JSON.stringify(report, null, 2));
    await new Promise((r) => setTimeout(r, 1100));
  }
  console.log(JSON.stringify({ coloredRows: applied.size, auditFile }));
}
main()
  .catch((error: unknown) => {
    if (error instanceof Error) console.error(`Failure type: ${error.name}`);
    if (error instanceof TypeError || error instanceof SyntaxError) console.error(error.message);
    if (
      error instanceof Error &&
      /^(Row |Unexpected workbook|Google Sheets request|Google token)/.test(error.message)
    )
      console.error(error.message);
    console.error(
      'Meta Sheets operation failed. Check database/Google connection and account selection. If applying colors, inspect color-audit files for completed writes.',
    );
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
