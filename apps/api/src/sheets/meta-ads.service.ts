/**
 * Meta Ads Library prospecting for the Dial page.
 *
 * The worker on the user's PC (workers/meta-ads) reads facebook.com/ads/library
 * and uploads every school↔ad pair it verified. This service stores that
 * evidence and, when the "Meta ad filter" button is pressed, copies the
 * matching rows of the selected tab into a new tab of the same spreadsheet.
 *
 * Two filters, exactly as the button offers them:
 *   ACTIVE (default) — the school has an ad Meta reports as running, seen in
 *     the last FRESH_DAYS. Older "Active" observations are not claimed as now.
 *   PAST — the school has an ad that has ended, whether or not it is also
 *     advertising today. That is the "they tried Meta before" list.
 */

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  MetaAdEvidenceDto,
  MetaAdFilterMode,
  MetaAdFilterResultDto,
  MetaAdsEvidenceSavedDto,
  MetaAdsStatusDto,
} from '@pstn-twilio/shared';

import { PrismaService } from '../prisma/prisma.service';

import { facebookKey, nameKey, schoolKey } from './facebook-url';
import { findColumns, SheetsService, text, type Row } from './sheets.service';
import { a1, normalizeHeader } from './sheets.util';

/** An "Active" ad older than this is history, not proof of advertising now. */
export const FRESH_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TAB_TITLE = 100;
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets/';

/**
 * Appended after the source tab's own columns so every filtered row can be
 * traced back to the ad it was matched on.
 */
export const META_HEADERS = [
  'metaAdId',
  'metaAdStatus',
  'metaAdStarted',
  'metaAdEnded',
  'metaAdvertiser',
  'metaAdObservedAt',
] as const;

export type StoredEvidence = {
  adId: string;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  observedAt: Date;
  advertiserName: string;
  advertiserUrl: string;
  facebookUrl: string;
};

type RowMatch = { row: Row; evidence: StoredEvidence };

@Injectable()
export class MetaAdsService {
  private readonly logger = new Logger(MetaAdsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sheets: SheetsService,
  ) {}

  // ── Evidence upload (worker) ──────────────────────────────────────────────

  /**
   * Upsert the batch: one row per (tab, school, ad). Upsert, not replace,
   * because a batch is one chunk of the worker's cumulative result set; a
   * school renamed later leaves its old pair behind, which `filter` reports as
   * `orphaned` and never matches against a row.
   */
  async saveEvidence(observations: MetaAdEvidenceDto[]): Promise<MetaAdsEvidenceSavedDto> {
    const tabs = new Set<string>();
    const writes = observations.map((o) => {
      tabs.add(`${o.spreadsheetId}:${o.sheetId}`);
      const data = {
        spreadsheetId: o.spreadsheetId,
        sheetId: o.sheetId,
        sheetTitle: o.sheetTitle,
        rowIndex: o.rowIndex,
        schoolTitle: o.schoolTitle,
        facebookUrl: o.facebookUrl,
        advertiserName: o.advertiserName,
        advertiserUrl: o.advertiserUrl,
        adId: o.adId,
        status: o.status,
        startedAt: o.startedAt ? new Date(`${o.startedAt}T00:00:00Z`) : null,
        endedAt: o.endedAt ? new Date(`${o.endedAt}T00:00:00Z`) : null,
        observedAt: new Date(o.observedAt),
      };
      return this.prisma.metaAdEvidence.upsert({
        where: {
          spreadsheetId_sheetId_adId_schoolTitle: {
            spreadsheetId: o.spreadsheetId,
            sheetId: o.sheetId,
            adId: o.adId,
            schoolTitle: o.schoolTitle,
          },
        },
        create: data,
        update: data,
      });
    });
    await this.prisma.$transaction(writes);

    this.logger.log(
      `Meta ad evidence: ${observations.length} pairs across ${tabs.size} tab${tabs.size === 1 ? '' : 's'}.`,
    );
    return { saved: observations.length, tabs: tabs.size };
  }

  // ── Status for the button ─────────────────────────────────────────────────

  async status(
    userId: string,
    spreadsheetId: string,
    sheetTitle: string,
  ): Promise<MetaAdsStatusDto> {
    const sheetId = await this.sheetIdOf(userId, spreadsheetId, sheetTitle);
    const evidence = await this.prisma.metaAdEvidence.findMany({
      where: { spreadsheetId, sheetId },
      select: { schoolTitle: true, facebookUrl: true, status: true, observedAt: true },
    });
    const cutoff = new Date(Date.now() - FRESH_DAYS * DAY_MS);
    const schools = new Map<string, { active: boolean; past: boolean }>();
    let lastObservedAt: Date | null = null;
    for (const e of evidence) {
      const key = schoolKey(e.schoolTitle, e.facebookUrl);
      const entry = schools.get(key) ?? { active: false, past: false };
      if (e.status === 'ACTIVE' && e.observedAt >= cutoff) entry.active = true;
      if (e.status === 'INACTIVE') entry.past = true;
      schools.set(key, entry);
      if (!lastObservedAt || e.observedAt > lastObservedAt) lastObservedAt = e.observedAt;
    }
    let active = 0;
    let past = 0;
    let both = 0;
    for (const entry of schools.values()) {
      if (entry.active) active++;
      if (entry.past) past++;
      if (entry.active && entry.past) both++;
    }
    return {
      spreadsheetId,
      sheetTitle,
      active,
      past,
      both,
      matched: schools.size,
      evidence: evidence.length,
      lastObservedAt: lastObservedAt?.toISOString() ?? null,
      freshDays: FRESH_DAYS,
    };
  }

  // ── The button ────────────────────────────────────────────────────────────

  /**
   * Copy the tab's matching rows into a new tab of the same spreadsheet.
   * Idempotent: a second press rewrites the same tab instead of stacking
   * "… (2)", "… (3)" copies.
   */
  async filter(
    userId: string,
    spreadsheetId: string,
    sourceSheetTitle: string,
    mode: MetaAdFilterMode,
  ): Promise<MetaAdFilterResultDto> {
    const token = await this.sheets.getAccessToken(userId);
    const tabs = await this.sheets.fetchTabs(token, spreadsheetId);
    const source = tabs.find((t) => t.title === sourceSheetTitle);
    if (!source) throw new NotFoundException(`Tab "${sourceSheetTitle}" no longer exists.`);

    const rows = await this.sheets.fetchRows(token, spreadsheetId, sourceSheetTitle);
    const header = rows[0] ?? [];
    if (header.length === 0)
      throw new NotFoundException(`"${sourceSheetTitle}" has no header row.`);
    const cols = findColumns(header.map(normalizeHeader));
    if (cols.school === -1) {
      throw new NotFoundException(
        `"${sourceSheetTitle}" has no title column (title, school or name) in row 1.`,
      );
    }

    const evidence = await this.prisma.metaAdEvidence.findMany({
      where: { spreadsheetId, sheetId: source.sheetId },
    });
    if (evidence.length === 0) {
      throw new BadRequestException(
        `The Meta ads worker has not reported any matches for "${sourceSheetTitle}" yet. ` +
          'Run workers/meta-ads (see its README) so it can verify this tab against the Ads Library.',
      );
    }

    const cutoff = new Date(Date.now() - FRESH_DAYS * DAY_MS);
    const byIdentity = new Map<string, StoredEvidence[]>();
    const byTitle = new Map<string, StoredEvidence[]>();
    const evidenceTitles = new Set<string>();
    for (const e of evidence) {
      const stored: StoredEvidence = {
        adId: e.adId,
        status: e.status,
        startedAt: e.startedAt,
        endedAt: e.endedAt,
        observedAt: e.observedAt,
        advertiserName: e.advertiserName,
        advertiserUrl: e.advertiserUrl,
        facebookUrl: e.facebookUrl,
      };
      push(byIdentity, schoolKey(e.schoolTitle, e.facebookUrl), stored);
      push(byTitle, nameKey(e.schoolTitle), stored);
      evidenceTitles.add(nameKey(e.schoolTitle));
    }

    const matches: RowMatch[] = [];
    const tabTitles = new Set<string>();
    let sourceRows = 0;
    let staleRows = 0;
    const urlColumn = cols.facebook;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i] ?? [];
      const title = text(row[cols.school]).trim();
      if (!title) continue;
      sourceRows++;
      tabTitles.add(nameKey(title));
      const url = urlColumn === -1 ? '' : text(row[urlColumn]).trim();
      const hits = matchRow(title, url, byIdentity, byTitle);
      if (hits.length === 0) continue;

      const activeNow = hits.some((h) => h.status === 'ACTIVE' && h.observedAt >= cutoff);
      const ended = hits.some((h) => h.status === 'INACTIVE');
      if (mode === 'ACTIVE') {
        if (!activeNow) {
          // Seen running once, but not recently enough to call it "now".
          if (hits.some((h) => h.status === 'ACTIVE')) staleRows++;
          continue;
        }
      } else if (!ended) {
        continue;
      }
      matches.push({ row, evidence: bestEvidence(hits, mode, cutoff) });
    }

    let widest = header.length;
    for (const row of rows) if (row.length > widest) widest = row.length;
    const width = widest + META_HEADERS.length;
    const values: string[][] = [
      padRow([...header.map((cell) => text(cell)), ...META_HEADERS], width),
      ...matches.map(({ row, evidence: e }) =>
        padRow(
          [
            ...row.map((cell) => text(cell)),
            e.adId,
            e.status === 'ACTIVE' ? 'Running' : 'Ended',
            isoDate(e.startedAt),
            isoDate(e.endedAt),
            e.advertiserName,
            isoDate(e.observedAt),
          ],
          width,
        ),
      ),
    ];

    const tabTitle = tabTitleFor(mode, sourceSheetTitle);
    const existing = tabs.find((t) => t.title === tabTitle);
    let sheetId: number;
    if (existing) {
      sheetId = existing.sheetId;
      // Clear first: the new result may be shorter than the previous one.
      await this.sheets.google(
        token,
        `${SHEETS}${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1(tabTitle))}:clear`,
        'clear meta ad filter tab',
        { method: 'POST', body: {} },
      );
      // The cleared grid may be too small for a bigger result.
      await this.sheets.google(
        token,
        `${SHEETS}${encodeURIComponent(spreadsheetId)}:batchUpdate`,
        'resize meta ad filter tab',
        {
          method: 'POST',
          body: {
            requests: [
              {
                updateSheetProperties: {
                  properties: {
                    sheetId,
                    gridProperties: {
                      rowCount: Math.max(1, values.length),
                      columnCount: width,
                    },
                  },
                  fields: 'gridProperties.rowCount,gridProperties.columnCount',
                },
              },
            ],
          },
        },
      );
    } else {
      const created = await this.sheets.google<{
        replies?: { addSheet?: { properties?: { sheetId?: number } } }[];
      }>(
        token,
        `${SHEETS}${encodeURIComponent(spreadsheetId)}:batchUpdate`,
        'create meta ad filter tab',
        {
          method: 'POST',
          body: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: tabTitle,
                    gridProperties: {
                      rowCount: Math.max(1, values.length),
                      columnCount: width,
                    },
                  },
                },
              },
            ],
          },
        },
      );
      sheetId = created.replies?.[0]?.addSheet?.properties?.sheetId ?? -1;
    }

    const range = a1(tabTitle, 'A1');
    await this.sheets.google(
      token,
      `${SHEETS}${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW&majorDimension=ROWS`,
      'write meta ad filter rows',
      { method: 'PUT', body: { range, majorDimension: 'ROWS', values } },
    );

    if (sheetId >= 0) {
      await this.sheets
        .google(
          token,
          `${SHEETS}${encodeURIComponent(spreadsheetId)}:batchUpdate`,
          'format meta ad filter tab',
          {
            method: 'POST',
            body: {
              requests: [
                {
                  repeatCell: {
                    range: {
                      sheetId,
                      startRowIndex: 0,
                      endRowIndex: 1,
                      startColumnIndex: 0,
                      endColumnIndex: width,
                    },
                    cell: {
                      userEnteredFormat: {
                        textFormat: { bold: true },
                        backgroundColor: { red: 0.93, green: 0.95, blue: 0.98 },
                      },
                    },
                    fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.backgroundColor',
                  },
                },
                {
                  updateSheetProperties: {
                    properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
                    fields: 'gridProperties.frozenRowCount',
                  },
                },
              ],
            },
          },
        )
        // Formatting is cosmetic: the rows are already written.
        .catch((err: Error) =>
          this.logger.warn(`Meta ad filter formatting skipped: ${err.message}`),
        );
    }

    const orphaned = [...evidenceTitles].filter((t) => !tabTitles.has(t)).length;
    this.logger.log(
      `Meta ad filter: ${tabTitle} ← ${matches.length}/${sourceRows} rows (${mode}).`,
    );
    return {
      spreadsheetId,
      sourceSheetTitle,
      tabTitle,
      reused: Boolean(existing),
      mode,
      rows: matches.length,
      sourceRows,
      staleRows,
      orphaned,
      createdAt: new Date().toISOString(),
    };
  }

  private async sheetIdOf(
    userId: string,
    spreadsheetId: string,
    sheetTitle: string,
  ): Promise<number> {
    const token = await this.sheets.getAccessToken(userId);
    const tabs = await this.sheets.fetchTabs(token, spreadsheetId);
    const tab = tabs.find((t) => t.title === sheetTitle);
    if (!tab) throw new NotFoundException(`Tab "${sheetTitle}" no longer exists.`);
    return tab.sheetId;
  }
}

function push(map: Map<string, StoredEvidence[]>, key: string, value: StoredEvidence): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * The evidence for one row. Title + facebookUrl is the identity the worker
 * verified; if the row's URL cell is empty (or was filled in later), a title
 * match is accepted only when the tab's evidence holds exactly one page for
 * that name. Nothing is guessed beyond that.
 */
export function matchRow(
  title: string,
  facebookUrl: string,
  byIdentity: Map<string, StoredEvidence[]>,
  byTitle: Map<string, StoredEvidence[]>,
): StoredEvidence[] {
  const exact = byIdentity.get(schoolKey(title, facebookUrl)) ?? [];
  if (exact.length > 0) return exact;
  // A row pointing at a different page is a different school: no title fallback.
  if (facebookKey(facebookUrl)) return [];
  const sameName = byTitle.get(nameKey(title)) ?? [];
  const pages = new Set(sameName.map((e) => facebookKey(e.facebookUrl)));
  return pages.size === 1 ? sameName : [];
}

function isoDate(date: Date | null): string {
  return date ? date.toISOString().slice(0, 10) : '';
}

/** Most recent ended ad for PAST; most recently observed running ad for ACTIVE. */
export function bestEvidence(
  hits: StoredEvidence[],
  mode: MetaAdFilterMode,
  cutoff: Date,
): StoredEvidence {
  const pool =
    mode === 'ACTIVE'
      ? hits.filter((h) => h.status === 'ACTIVE' && h.observedAt >= cutoff)
      : hits.filter((h) => h.status === 'INACTIVE');
  const use = pool.length > 0 ? pool : hits;
  return [...use].sort(
    (a, b) =>
      (b.endedAt?.getTime() ?? 0) - (a.endedAt?.getTime() ?? 0) ||
      b.observedAt.getTime() - a.observedAt.getTime() ||
      a.adId.localeCompare(b.adId),
  )[0]!;
}

function padRow(row: string[], width: number): string[] {
  const out = row.slice(0, width);
  while (out.length < width) out.push('');
  return out;
}

/**
 * "Meta ads - running now - Texas": deterministic, so a second press rewrites
 * the same tab. Sanitized for Sheets' title rules and capped at 100 characters.
 */
export function tabTitleFor(mode: MetaAdFilterMode, sourceSheetTitle: string): string {
  const prefix = mode === 'ACTIVE' ? 'Meta ads - running now - ' : 'Meta ads - ran in the past - ';
  const room = MAX_TAB_TITLE - prefix.length;
  const cleaned = sourceSheetTitle
    .replace(/[\\/?*[\]:"]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^'+|'+$/g, '')
    .trim()
    .slice(0, room)
    .trim();
  return `${prefix}${cleaned || 'sheet'}`;
}
