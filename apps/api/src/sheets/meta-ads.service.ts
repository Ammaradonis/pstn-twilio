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
 * traced back to the ad it was matched on. `metaMatch` says which identity
 * matched: "page" (the tab's own Facebook page is the ad's page) or "name" (the
 * tab has no page URL, so the exact school name is what matched).
 */
export const META_HEADERS = [
  'metaAdId',
  'metaAdStatus',
  'metaAdStarted',
  'metaAdEnded',
  'metaAdvertiser',
  'metaAdObservedAt',
  'metaMatch',
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
  // '' for rows stored before match_kind existed: unknown, not "page".
  matchKind: 'page' | 'name' | '';
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
        // Older workers only sent page-verified pairs, so a missing field is "page".
        matchKind: o.matchKind ?? 'page',
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
        matchKind: e.matchKind === 'name' || e.matchKind === 'page' ? e.matchKind : '',
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
    // Sheets drops each row's trailing empty cells, so most rows come back
    // shorter than the header. Pad every row to the widest one first, or the
    // meta values land under the wrong headers.
    const cells = (row: Row) =>
      padRow(
        row.map((cell) => text(cell)),
        widest,
      );
    const values: string[][] = [
      [...cells(header), ...META_HEADERS],
      ...matches.map(({ row, evidence: e }) => [
        ...cells(row),
        e.adId,
        e.status === 'ACTIVE' ? 'Running' : 'Ended',
        isoDate(e.startedAt),
        isoDate(e.endedAt),
        e.advertiserName,
        isoDate(e.observedAt),
        e.matchKind,
      ]),
    ];

    const tabTitle = tabTitleFor(mode, sourceSheetTitle);
    const existing = tabs.find((t) => t.title === tabTitle);
    // One row past the frozen header: Sheets refuses a grid whose every row is
    // frozen, so a re-press with no matches could not resize the tab.
    const rowCount = Math.max(2, values.length);
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
                    gridProperties: { rowCount, columnCount: width },
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
                    gridProperties: { rowCount, columnCount: width },
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
    // majorDimension goes in the body only: values.update rejects it as a query
    // parameter ("Cannot bind query parameter"), and every press used to fail
    // here after the tab was created, leaving it empty.
    await this.sheets.google(
      token,
      `${SHEETS}${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
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

/** The page an evidence row proves: the advertiser's, else the tab's own cell. */
export function evidencePage(evidence: StoredEvidence): string {
  return facebookKey(evidence.advertiserUrl) || facebookKey(evidence.facebookUrl);
}

/**
 * The evidence for one row.
 *
 * A row that names a page only accepts ads that ran from *that* page; an ad from
 * another page is a different school, whatever the names say. A row with no page
 * URL (92% of the tabs) is matched by its exact normalized school name, and only
 * when every ad for that name comes from one page — two advertisers sharing a
 * name say nothing about which one is this school. The name case is why the
 * worker uploads name-only evidence at all: without it those rows could never
 * match, and the button looked dead.
 */
export function matchRow(
  title: string,
  facebookUrl: string,
  byIdentity: Map<string, StoredEvidence[]>,
  byTitle: Map<string, StoredEvidence[]>,
): StoredEvidence[] {
  const page = facebookKey(facebookUrl);
  const sameName = byTitle.get(nameKey(title)) ?? [];
  if (page) {
    // The evidence the worker verified against this exact row keeps its weight
    // even when the ad card's page did not parse, so identity is not lost.
    const exact = byIdentity.get(schoolKey(title, facebookUrl)) ?? [];
    return unique([...sameName.filter((e) => evidencePage(e) === page), ...exact]);
  }
  const pages = new Set(sameName.map(evidencePage).filter(Boolean));
  if (pages.size !== 1) return [];
  return sameName;
}

function unique(items: StoredEvidence[]): StoredEvidence[] {
  return [...new Set(items)];
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
