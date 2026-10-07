/**
 * SheetsService
 *
 *  - Google OAuth (Sheets + Drive metadata + Gmail send), same pattern as
 *    GoogleCalendarService.
 *  - Lists spreadsheets and their tabs for the Dial page picker.
 *  - Post-call push: finds the row whose phoneNumber matches the dialled
 *    number, writes "<statuses>, <note>, from: <caller>, time: <their time>"
 *    into the Status column (created if missing) and schedules the 48-hour
 *    follow-up email.
 *  - Checks the "U.S. Conquest" addresses against the time zone resolver and
 *    learns city → zone pairs from them.
 */

import { randomUUID } from 'crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  pickFollowUpTemplate,
  US_STATES,
  type PushCallResultDto,
  type SheetsConnectionStatusDto,
  type SheetsEmailStatus,
  type SheetsFollowUpDto,
  type SheetsSequenceWorkbookDto,
  type SheetsSpreadsheetDto,
  type SheetsStatusDto,
  type SheetsTimeZoneCheckDto,
  type SheetsTimeZoneSource,
  type SheetTabDto,
} from '@pstn-twilio/shared';

import {
  decryptSecret,
  encryptSecret,
  signPayload,
  verifySignedPayload,
} from '../common/secret-box';
import { PrismaService } from '../prisma/prisma.service';

import { DEMO_NUMBERS, type Region } from './follow-up-sequences';
import { rowRecord, type RowData } from './follow-up-vars';
import {
  cityKey,
  parseUsAddress,
  resolveTimeZone,
  SheetsTimezoneService,
} from './sheets-timezone.service';
import { SheetsConfig } from './sheets.config';
import {
  a1,
  cellHasPhone,
  columnLetter,
  extractEmail,
  formatStatusTime,
  nationalDigits,
  normalizeHeader,
  stripCountryCode,
} from './sheets.util';

// Optional: lets the follow-up sweep see replies and stop a sequence.
export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  GMAIL_READ_SCOPE,
];

const STATUS_HEADER = 'Status';
const FOLLOW_UP_DELAY_MS = 48 * 60 * 60 * 1000;
// A school already emailed this recently doesn't get a second cold email.
const RECENT_EMAIL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 15 * 60_000;

type OAuthState = { u: string; exp: number; n: string };
export type Cell = string | number | boolean | null | undefined;
export type Row = Cell[];

export class SheetsUnavailableError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'SheetsUnavailableError';
  }
}

/** Google refused the stored access: nothing works until it's reconnected. */
export class GoogleAuthError extends SheetsUnavailableError {
  constructor(msg: string) {
    super(msg);
    this.name = 'GoogleAuthError';
  }
}

@Injectable()
export class SheetsService {
  private readonly logger = new Logger(SheetsService.name);
  private readonly accessTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly cfg: SheetsConfig,
    private readonly tz: SheetsTimezoneService,
  ) {}

  // ── OAuth ─────────────────────────────────────────────────────────────────

  async status(userId: string): Promise<SheetsConnectionStatusDto> {
    const conn = await this.prisma.googleSheetsConnection.findUnique({ where: { userId } });
    // A stored connection isn't proof Google still accepts it: refresh the
    // token (cached for an hour) so a revoked or expired grant shows here
    // instead of as failed pushes and follow-ups.
    let problem: string | null = null;
    let needsReconnect = false;
    if (conn && this.cfg.isConfigured()) {
      try {
        await this.getAccessToken(userId);
      } catch (err) {
        problem = (err as Error).message;
        needsReconnect = err instanceof GoogleAuthError;
      }
    }
    return {
      connected: Boolean(conn),
      email: conn?.googleEmail ?? null,
      configured: this.cfg.isConfigured(),
      missing: this.cfg.missing(),
      needsReconnect,
      problem,
    };
  }

  authorizationUrl(userId: string): string {
    this.requireConfigured();
    const state = signPayload(
      { u: userId, exp: Date.now() + STATE_TTL_MS, n: randomUUID() } satisfies OAuthState,
      this.cfg.stateSigningSecret!,
    );
    const params = new URLSearchParams({
      client_id: this.cfg.googleClientId!,
      redirect_uri: this.cfg.oauthRedirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async completeAuthorization(code: string, state: string): Promise<void> {
    this.requireConfigured();
    const payload = verifySignedPayload<OAuthState>(state, this.cfg.stateSigningSecret!);
    if (!payload || payload.exp < Date.now()) {
      throw new SheetsUnavailableError('The Google sign-in link expired. Try connecting again.');
    }

    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.cfg.oauthRedirectUri,
    });
    if (!tokens.refresh_token) {
      throw new SheetsUnavailableError(
        'Google did not return offline access. Remove the app at myaccount.google.com/permissions and connect again.',
      );
    }
    const granted = String(tokens.scope ?? '');
    const missing = SCOPES.filter(
      (s) => s.startsWith('https://') && s !== GMAIL_READ_SCOPE && !granted.includes(s),
    );
    if (missing.length > 0) {
      throw new SheetsUnavailableError(
        'Not every permission was granted. Connect again and tick all the boxes (Sheets, Drive file list, Gmail send).',
      );
    }

    const data = {
      googleEmail: emailFromIdToken(tokens.id_token),
      refreshTokenEncrypted: encryptSecret(tokens.refresh_token, this.cfg.tokenEncryptionKey!),
      scopes: granted,
    };
    await this.prisma.googleSheetsConnection.upsert({
      where: { userId: payload.u },
      create: { userId: payload.u, ...data },
      update: data,
    });
    this.accessTokens.set(payload.u, {
      token: tokens.access_token,
      expiresAt: Date.now() + (Number(tokens.expires_in ?? 3600) - 60) * 1000,
    });
  }

  async disconnect(userId: string): Promise<void> {
    const conn = await this.prisma.googleSheetsConnection.findUnique({ where: { userId } });
    if (!conn) return;
    this.accessTokens.delete(userId);
    // Deleting the connection also drops its logs, including pending emails.
    await this.prisma.googleSheetsConnection.delete({ where: { userId } });
    try {
      const rt = decryptSecret(conn.refreshTokenEncrypted, this.cfg.tokenEncryptionKey!);
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: rt }),
      });
    } catch (err) {
      this.logger.warn(`Google token revoke failed: ${(err as Error).message}`);
    }
  }

  // ── Spreadsheet / tab listing ─────────────────────────────────────────────

  async listSpreadsheets(userId: string): Promise<SheetsSpreadsheetDto[]> {
    const token = await this.getAccessToken(userId);
    const out: SheetsSpreadsheetDto[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL('https://www.googleapis.com/drive/v3/files');
      url.searchParams.set(
        'q',
        "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
      );
      url.searchParams.set('fields', 'nextPageToken,files(id,name)');
      url.searchParams.set('pageSize', '1000');
      url.searchParams.set('orderBy', 'modifiedTime desc');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const body = await this.google<{
        files?: { id: string; name: string }[];
        nextPageToken?: string;
      }>(token, url.toString(), 'list spreadsheets');
      for (const f of body.files ?? []) out.push({ spreadsheetId: f.id, name: f.name });
      pageToken = body.nextPageToken;
    } while (pageToken && out.length < 5000);
    return out;
  }

  async listSheetTabs(userId: string, spreadsheetId: string): Promise<SheetTabDto[]> {
    const token = await this.getAccessToken(userId);
    const tabs = await this.fetchTabs(token, spreadsheetId);
    return tabs.map(({ sheetId, title }) => ({ sheetId, title }));
  }

  /**
   * The two workbooks with their own follow-up sequence, checked against
   * Google: the configured ID should be the spreadsheet with that name. When
   * it isn't, a spreadsheet that does have the name is suggested.
   */
  async sequenceWorkbooks(userId: string): Promise<SheetsSequenceWorkbookDto[]> {
    const token = await this.getAccessToken(userId);
    const workbooks: { region: Region; expectedName: string; spreadsheetId: string }[] = [
      {
        region: 'US',
        expectedName: this.cfg.conquestSheetName,
        spreadsheetId: this.cfg.conquestSheetId,
      },
      { region: 'UK', expectedName: this.cfg.ukSheetName, spreadsheetId: this.cfg.ukSheetId },
    ];
    return Promise.all(
      workbooks.map(async (w) => {
        let googleName: string | null = null;
        let error: string | null = null;
        try {
          const file = await this.google<{ name?: string; trashed?: boolean }>(
            token,
            `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(w.spreadsheetId)}?fields=name,trashed`,
            `find ${w.expectedName}`,
          );
          googleName = file.trashed ? null : (file.name ?? null);
          if (file.trashed) error = `${file.name ?? 'This spreadsheet'} is in the Drive bin.`;
        } catch (err) {
          error = (err as Error).message;
        }
        const matches = googleName !== null && sameSheetName(googleName, w.expectedName);
        let suggestedId: string | null = null;
        if (!matches) {
          const url = new URL('https://www.googleapis.com/drive/v3/files');
          url.searchParams.set(
            'q',
            `name = '${w.expectedName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`,
          );
          url.searchParams.set('fields', 'files(id,name)');
          const found = await this.google<{ files?: { id: string }[] }>(
            token,
            url.toString(),
            `search for ${w.expectedName}`,
          ).catch(() => ({ files: [] as { id: string }[] }));
          suggestedId = found.files?.[0]?.id ?? null;
        }
        return {
          ...w,
          googleName,
          matches,
          suggestedId,
          demoNumber: DEMO_NUMBERS[w.region],
          error,
        };
      }),
    );
  }

  // ── Post-call push ────────────────────────────────────────────────────────

  async pushCallResult(userId: string, dto: PushCallResultDto): Promise<SheetsStatusDto> {
    const conn = await this.prisma.googleSheetsConnection.findUnique({ where: { userId } });
    if (!conn) throw new SheetsUnavailableError('Google Sheets is not connected.');
    const token = await this.getAccessToken(userId);

    const target = nationalDigits(dto.destinationE164);
    if (!target)
      throw new SheetsUnavailableError(`"${dto.destinationE164}" is not a US/UK number.`);

    const tab = (await this.fetchTabs(token, dto.spreadsheetId)).find(
      (t) => t.title === dto.sheetTitle,
    );
    if (!tab) throw new NotFoundException(`Tab "${dto.sheetTitle}" no longer exists.`);
    const rows = await this.fetchRows(token, dto.spreadsheetId, dto.sheetTitle);
    const headers = (rows[0] ?? []).map(normalizeHeader);
    if (headers.length === 0) throw new NotFoundException(`"${dto.sheetTitle}" has no header row.`);

    const cols = findColumns(headers);
    if (cols.phone === -1) {
      throw new NotFoundException(`No "phoneNumber" column in row 1 of "${dto.sheetTitle}".`);
    }

    const matches: number[] = [];
    for (let i = 1; i < rows.length; i++) {
      if (cellHasPhone(text(rows[i]?.[cols.phone]), target)) matches.push(i);
    }
    if (matches.length === 0) {
      throw new NotFoundException(
        `${stripCountryCode(dto.destinationE164)} isn't in the phoneNumber column of "${dto.sheetTitle}".`,
      );
    }
    const rowIdx = matches[0]!;
    const row = rows[rowIdx] ?? [];

    const statusCol = cols.status !== -1 ? cols.status : firstEmptyColumn(rows);
    if (statusCol + 1 > tab.columnCount) {
      await this.appendColumns(
        token,
        dto.spreadsheetId,
        tab.sheetId,
        statusCol + 1 - tab.columnCount,
      );
    }

    const callEndedAt = new Date(dto.callEndedAt);
    const { timeZone, source } = await this.tz.resolve(rowAddress(row, cols), dto.destinationE164);
    const cellValue = buildCellValue(dto, formatStatusTime(callEndedAt, timeZone));

    const data = [
      {
        range: a1(dto.sheetTitle, `${columnLetter(statusCol + 1)}${rowIdx + 1}`),
        values: [[cellValue]],
      },
    ];
    if (cols.status === -1) {
      data.push({
        range: a1(dto.sheetTitle, `${columnLetter(statusCol + 1)}1`),
        values: [[STATUS_HEADER]],
      });
    }
    // RAW so a note starting with "=" or "+" stays text.
    await this.google(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(dto.spreadsheetId)}/values:batchUpdate`,
      'write status',
      { method: 'POST', body: { valueInputOption: 'RAW', data } },
    );

    const contactFormUrl =
      cols.contactForm !== -1 ? text(row[cols.contactForm]).trim() || null : null;
    const email = await this.planFollowUp(
      conn.id,
      dto,
      extractEmail(text(row[cols.email])),
      contactFormUrl,
    );
    const dueAt = ['PENDING', 'MANUAL', 'WAITING_RESEARCH'].includes(email.status)
      ? new Date(Math.max(callEndedAt.getTime() + FOLLOW_UP_DELAY_MS, Date.now()))
      : null;
    const bookedDemo = dto.orderedTags.includes('Booked a demo');

    // An overwrite replaces the earlier outcome, so its unsent email goes too.
    // A sequence that has already started keeps going (the new push doesn't
    // email them again), unless they booked a demo: then it stops.
    await this.prisma.$transaction([
      this.prisma.sheetsPushLog.updateMany({
        where: {
          connectionId: conn.id,
          destinationE164: dto.destinationE164,
          emailStatus: { in: ['PENDING', 'MANUAL', 'WAITING_RESEARCH', 'FORM_PREPARING'] },
          ...(bookedDemo ? {} : { emailSentAt: null }),
        },
        data: {
          emailStatus: 'CANCELLED',
          emailError: bookedDemo ? 'Booked a demo; sequence stopped.' : 'Replaced by a newer push.',
        },
      }),
      this.prisma.sheetsPushLog.create({
        data: {
          connectionId: conn.id,
          spreadsheetId: dto.spreadsheetId,
          sheetTitle: dto.sheetTitle,
          rowIndex: rowIdx + 1,
          destinationE164: dto.destinationE164,
          callerE164: dto.callerE164,
          tags: dto.orderedTags,
          customNote: dto.customNote?.trim() || null,
          cellValue,
          timeZone,
          schoolName: cols.school !== -1 ? text(row[cols.school]).trim() || null : null,
          emailStatus: email.status,
          emailTo: email.to,
          emailTemplate: email.template,
          emailDueAt: dueAt,
          contactFormUrl: !email.to ? contactFormUrl : null,
          rowData: rowRecord(headers, row) as Prisma.InputJsonValue,
          callEndedAt,
        },
      }),
    ]);

    return {
      spreadsheetId: dto.spreadsheetId,
      sheetTitle: dto.sheetTitle,
      rowIndex: rowIdx + 1,
      duplicateRows: matches.slice(1).map((i) => i + 1),
      cellValue,
      timeZone,
      timeZoneSource: source,
      emailStatus: email.status,
      emailTo: email.to,
      emailTemplate: email.template,
      emailDueAt: dueAt?.toISOString() ?? null,
      emailNote: email.note,
    };
  }

  private async planFollowUp(
    connectionId: string,
    dto: PushCallResultDto,
    to: string | null,
    contactFormUrl: string | null,
  ): Promise<{
    status: SheetsEmailStatus;
    to: string | null;
    template: string | null;
    note: string | null;
  }> {
    const decision = pickFollowUpTemplate(dto.orderedTags);
    if (decision.template === null) {
      return { status: 'NONE', to, template: null, note: decision.reason };
    }
    if (!to) {
      return {
        status: 'WAITING_RESEARCH',
        to: null,
        template: decision.template,
        note: contactFormUrl
          ? 'Follow-up will use the contact form after email research is complete.'
          : 'Follow-up is waiting for email research on this school.',
      };
    }
    // A sequence still running (PENDING with an email already sent) counts too.
    const recent = await this.prisma.sheetsPushLog.findFirst({
      where: {
        connectionId,
        emailTo: { equals: to, mode: 'insensitive' },
        emailStatus: { in: ['SENT', 'SENDING', 'PENDING'] },
        emailSentAt: { gte: new Date(Date.now() - RECENT_EMAIL_WINDOW_MS) },
      },
      select: { emailSentAt: true, emailStatus: true, sequenceStep: true },
    });
    if (recent) {
      return {
        status: 'NONE',
        to,
        template: decision.template,
        note:
          recent.emailStatus === 'PENDING'
            ? `A follow-up sequence to ${to} is already running (email ${recent.sequenceStep} of 6 is next); not starting another.`
            : `Already emailed ${to} on ${recent.emailSentAt?.toISOString().slice(0, 10)}; not sending another.`,
      };
    }
    return { status: 'PENDING', to, template: decision.template, note: null };
  }

  // ── Follow-up list ────────────────────────────────────────────────────────

  async listFollowUps(userId: string): Promise<SheetsFollowUpDto[]> {
    const rows = await this.prisma.sheetsPushLog.findMany({
      where: { connection: { userId }, emailStatus: { not: 'NONE' } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => ({
      id: r.id,
      destinationE164: r.destinationE164,
      sheetTitle: r.sheetTitle,
      rowIndex: r.rowIndex,
      emailTo: r.emailTo,
      emailTemplate: r.emailTemplate,
      emailStatus: r.emailStatus as SheetsEmailStatus,
      sequenceStep: r.sequenceStep,
      emailDueAt: r.emailDueAt?.toISOString() ?? null,
      emailSentAt: r.emailSentAt?.toISOString() ?? null,
      emailError: r.emailError,
      contactFormUrl: r.contactFormUrl,
    }));
  }

  async cancelFollowUp(userId: string, id: string): Promise<void> {
    const res = await this.prisma.sheetsPushLog.updateMany({
      where: {
        id,
        connection: { userId },
        emailStatus: { in: ['PENDING', 'MANUAL', 'WAITING_RESEARCH', 'FORM_PREPARING'] },
      },
      data: { emailStatus: 'CANCELLED', emailError: 'Cancelled by you.' },
    });
    if (res.count === 0) throw new NotFoundException('No pending email with that id.');
  }

  /** A contact-form follow-up the user sent by hand. */
  async markFollowUpSent(userId: string, id: string): Promise<void> {
    const res = await this.prisma.sheetsPushLog.updateMany({
      where: { id, connection: { userId }, emailStatus: 'MANUAL' },
      data: { emailStatus: 'SENT', emailSentAt: new Date(), emailError: null },
    });
    if (res.count === 0) throw new NotFoundException('No contact-form follow-up with that id.');
  }

  /** The lead's row (by normalized header) for a dialed number, or null if it's no longer in the tab. */
  async readLeadRow(
    userId: string,
    spreadsheetId: string,
    sheetTitle: string,
    destinationE164: string,
  ): Promise<RowData | null> {
    const target = nationalDigits(destinationE164);
    if (!target) return null;
    const token = await this.getAccessToken(userId);
    const rows = await this.fetchRows(token, spreadsheetId, sheetTitle);
    const headers = (rows[0] ?? []).map(normalizeHeader);
    const cols = findColumns(headers);
    if (cols.phone === -1) return null;
    const row = rows.slice(1).find((r) => cellHasPhone(text(r?.[cols.phone]), target));
    return row ? rowRecord(headers, row) : null;
  }

  async followUpLog(userId: string, id: string) {
    const log = await this.prisma.sheetsPushLog.findFirst({
      where: { id, connection: { userId } },
    });
    if (!log) throw new NotFoundException('No follow-up with that id.');
    return log;
  }

  // ── U.S. Conquest time zone check ─────────────────────────────────────────

  async checkConquest(userId: string): Promise<SheetsTimeZoneCheckDto> {
    const token = await this.getAccessToken(userId);
    const spreadsheetId = this.cfg.conquestSheetId;
    const tabs = await this.fetchTabs(token, spreadsheetId);

    const addresses: { tab: string; row: number; address: string }[] = [];
    let noAddress = 0;
    for (let i = 0; i < tabs.length; i += 20) {
      const chunk = tabs.slice(i, i + 20);
      const url = new URL(
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet`,
      );
      for (const t of chunk) url.searchParams.append('ranges', a1(t.title));
      const body = await this.google<{ valueRanges?: { values?: Row[] }[] }>(
        token,
        url.toString(),
        'read U.S. Conquest',
      );
      body.valueRanges?.forEach((vr, j) => {
        const rows = vr.values ?? [];
        const cols = findColumns((rows[0] ?? []).map(normalizeHeader));
        for (let r = 1; r < rows.length; r++) {
          const address = rowAddress(rows[r] ?? [], cols);
          if (address) addresses.push({ tab: chunk[j]!.title, row: r + 1, address });
          else if (rows[r]?.some((c) => text(c).trim())) noAddress++;
        }
      });
    }

    // Learn city → zone from addresses whose ZIP pins the zone; drop cities
    // whose addresses disagree (a city spanning a zone line).
    const votes = new Map<string, Set<string>>();
    for (const { address } of addresses) {
      const parsed = parseUsAddress(address);
      if (!parsed.zip || !parsed.city || !parsed.stateCode) continue;
      const resolved = resolveTimeZone(address, '+1');
      if (resolved.source !== 'zip') continue;
      const key = cityKey(parsed.city, parsed.stateCode);
      votes.set(key, (votes.get(key) ?? new Set()).add(resolved.timeZone));
    }
    const learned: Record<string, string> = {};
    for (const [key, zones] of votes) if (zones.size === 1) learned[key] = [...zones][0]!;
    await this.tz.saveLearnedCities(learned);

    const bySource: Record<SheetsTimeZoneSource | 'none', number> = {
      uk: 0,
      zip: 0,
      city: 0,
      state: 0,
      guess: 0,
      none: noAddress,
    };
    const uncertain: SheetsTimeZoneCheckDto['uncertain'] = [];
    for (const item of addresses) {
      const resolved = resolveTimeZone(item.address, '+1', learned);
      bySource[resolved.source]++;
      if (resolved.source === 'guess' && uncertain.length < 50) {
        const state = US_STATES.find((s) => s.code === parseUsAddress(item.address).stateCode);
        if (!state || state.timeZones.length > 1)
          uncertain.push({ ...item, timeZone: resolved.timeZone });
      }
    }
    return {
      tabs: tabs.length,
      addresses: addresses.length,
      bySource,
      learnedCities: Object.keys(learned).length,
      uncertain,
    };
  }

  // ── Google API helpers ────────────────────────────────────────────────────

  async fetchTabs(
    token: string,
    spreadsheetId: string,
  ): Promise<{ sheetId: number; title: string; columnCount: number }[]> {
    const body = await this.google<{
      sheets?: {
        properties: { sheetId: number; title: string; gridProperties?: { columnCount?: number } };
      }[];
    }>(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?fields=sheets.properties(sheetId,title,gridProperties.columnCount)`,
      'list tabs',
    );
    return (body.sheets ?? []).map(({ properties: p }) => ({
      sheetId: p.sheetId,
      title: p.title,
      columnCount: p.gridProperties?.columnCount ?? 26,
    }));
  }

  async fetchRows(token: string, spreadsheetId: string, sheetTitle: string): Promise<Row[]> {
    const body = await this.google<{ values?: Row[] }>(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(a1(sheetTitle))}`,
      'read sheet',
    );
    return body.values ?? [];
  }

  async appendColumns(token: string, spreadsheetId: string, sheetId: number, length: number) {
    await this.google(
      token,
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
      'add Status column',
      {
        method: 'POST',
        body: { requests: [{ appendDimension: { sheetId, dimension: 'COLUMNS', length } }] },
      },
    );
  }

  async google<T>(
    token: string,
    url: string,
    ctx: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) {
      throw new SheetsUnavailableError(
        `Google API error (${ctx}): ${body.error?.message ?? `HTTP ${res.status}`}`,
      );
    }
    return body;
  }

  // ── OAuth token management ────────────────────────────────────────────────

  async hasScope(userId: string, scope: string): Promise<boolean> {
    const conn = await this.prisma.googleSheetsConnection.findUnique({
      where: { userId },
      select: { scopes: true },
    });
    return Boolean(conn?.scopes.split(/\s+/).includes(scope));
  }

  /** Also used by GmailService: one grant covers Sheets and Gmail. */
  async getAccessToken(userId: string): Promise<string> {
    const cached = this.accessTokens.get(userId);
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const conn = await this.prisma.googleSheetsConnection.findUnique({ where: { userId } });
    if (!conn) throw new SheetsUnavailableError('Google Sheets is not connected.');
    this.requireConfigured();
    let rt: string;
    try {
      rt = decryptSecret(conn.refreshTokenEncrypted, this.cfg.tokenEncryptionKey!);
    } catch {
      throw new GoogleAuthError(
        'The saved Google access can no longer be read (TOKEN_ENCRYPTION_KEY changed). Reconnect in Settings → Google Sheets & Gmail.',
      );
    }
    const tokens = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: rt });
    this.accessTokens.set(userId, {
      token: tokens.access_token,
      expiresAt: Date.now() + (Number(tokens.expires_in ?? 3600) - 60) * 1000,
    });
    return tokens.access_token;
  }

  private requireConfigured(): void {
    if (!this.cfg.isConfigured()) {
      throw new SheetsUnavailableError(
        `Google Sheets is not configured on the API: set ${this.cfg.missing().join(', ')}.`,
      );
    }
  }

  private async tokenRequest(params: Record<string, string>): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
  }> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.googleClientId!,
        client_secret: this.cfg.googleClientSecret!,
        ...params,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      if (body.error === 'invalid_grant') {
        // Also what Google says every 7 days while the OAuth consent screen is
        // in "Testing": publishing the app (it can stay unverified) ends that.
        throw new GoogleAuthError(
          'Google access was revoked or expired. Reconnect in Settings → Google Sheets & Gmail.',
        );
      }
      if (body.error === 'invalid_client' || body.error === 'unauthorized_client') {
        throw new GoogleAuthError(
          `Google rejected the OAuth client (${body.error}): check GOOGLE_CLOUD_CLIENT_ID and GOOGLE_CLOUD_CLIENT_SECRET on the API.`,
        );
      }
      throw new SheetsUnavailableError(
        `Google token request failed: ${body.error_description ?? body.error ?? res.status}`,
      );
    }
    return body as { access_token: string };
  }
}

/** "U.S. Conquest " and "us conquest" are the same workbook name. */
export function sameSheetName(a: string, b: string): boolean {
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return squash(a) === squash(b);
}

// ── Row helpers ───────────────────────────────────────────────────────────────

export interface Columns {
  phone: number;
  status: number;
  address: number;
  city: number;
  state: number;
  zip: number;
  email: number;
  school: number;
  website: number;
  facebook: number;
  instagram: number;
  twitter: number;
  linkedin: number;
  youtube: number;
  tiktok: number;
  category: number;
  emailType: number;
  emailSource: number;
  decisionMaker: number;
  contactForm: number;
}

// Columns the email finder adds (header text as written into row 1).
export const FINDER_HEADERS = {
  email: 'email',
  emailType: 'emailType',
  emailSource: 'emailSource',
  decisionMaker: 'decisionMaker',
  contactForm: 'contactForm',
} as const;

export function findColumns(headers: string[]): Columns {
  const exact = (...names: string[]) => headers.findIndex((h) => names.includes(h));
  const first = (...indexes: number[]) => indexes.find((i) => i !== -1) ?? -1;
  const finderOwn = new Set(['emailtype', 'emailsource', 'decisionmaker', 'contactform']);
  return {
    phone: first(
      exact('phonenumber'),
      exact('phone', 'telephone', 'tel', 'phoneno'),
      headers.findIndex((h) => h.includes('phone')),
    ),
    status: exact('status'),
    address: first(
      exact('address', 'fulladdress', 'streetaddress'),
      headers.findIndex((h) => h.includes('address') && !h.includes('email')),
    ),
    city: exact('city', 'town'),
    state: exact('state', 'statecode'),
    zip: exact('zip', 'zipcode', 'postalcode', 'postcode'),
    email: first(
      exact('email', 'emailaddress'),
      headers.findIndex((h) => h.includes('email') && !finderOwn.has(h)),
    ),
    school: first(
      exact('schoolname', 'school', 'businessname', 'title', 'name'),
      headers.findIndex((h) => h.includes('school')),
    ),
    website: first(exact('websiteurl', 'website', 'url', 'site', 'web')),
    facebook: first(exact('facebookurl', 'facebook', 'fb')),
    instagram: first(exact('instagramurl', 'instagram', 'ig')),
    twitter: exact('twitterurl', 'twitter', 'xurl'),
    linkedin: exact('linkedinurl', 'linkedin'),
    youtube: exact('youtubeurl', 'youtube'),
    tiktok: exact('tiktokurl', 'tiktok'),
    category: exact('category', 'type', 'style'),
    emailType: exact('emailtype'),
    emailSource: exact('emailsource'),
    decisionMaker: exact('decisionmaker'),
    contactForm: exact('contactform'),
  };
}

/** The row's address, completed with separate city/state/zip columns if present. */
export function rowAddress(row: Row, cols: Columns): string | null {
  let address = cols.address !== -1 ? text(row[cols.address]).trim() : '';
  const lower = address.toLowerCase();
  const extra = [cols.city, cols.state, cols.zip]
    .filter((i) => i !== -1)
    .map((i) => text(row[i]).trim())
    .filter((v) => v && !lower.includes(v.toLowerCase()));
  if (extra.length > 0) address = [address, extra.join(' ')].filter(Boolean).join(', ');
  return address || null;
}

/** First column that is empty in every row (header included). */
export function firstEmptyColumn(rows: Row[], skip: number[] = []): number {
  const width = Math.max(0, ...rows.map((r) => r.length));
  for (let c = 0; c < width; c++) {
    if (!skip.includes(c) && rows.every((r) => !text(r[c]).trim())) return c;
  }
  let c = width;
  while (skip.includes(c)) c++;
  return c;
}

/** "Voicemail, Not interested, <note>, from: 6672206726, time: 9:45am" */
export function buildCellValue(dto: PushCallResultDto, localTime: string): string {
  const parts: string[] = [dto.orderedTags.join(', ')];
  const note = dto.customNote?.replace(/\s+/g, ' ').trim();
  if (note) parts.push(note);
  parts.push(`from: ${stripCountryCode(dto.callerE164)}`, `time: ${localTime}`);
  return parts.join(', ');
}

export function text(cell: Cell): string {
  return cell === null || cell === undefined ? '' : String(cell);
}

function emailFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: string;
    };
    return claims.email ?? null;
  } catch {
    return null;
  }
}
