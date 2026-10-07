/**
 * Email finder queue.
 *
 * Picking a tab on the Dial page queues every row that has no email yet.
 * The worker on the user's PC (workers/email-finder) claims rows, researches
 * them and posts results back; results are written into the tab in batches:
 * email, emailType, emailSource, decisionMaker and contactForm columns
 * (created next to the data if missing). Rows are matched by a fingerprint of
 * name + phone + website, so sorting or inserting rows mid-run is safe, and a
 * row that already has an email is never overwritten. Each address found is
 * also pushed to the user's open Dial page (and listed by status() for polling).
 */

import { createHash, randomUUID } from 'crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type {
  EmailFinderFindDto,
  EmailFinderJobStatus,
  EmailFinderStatusDto,
} from '@pstn-twilio/shared';

import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RedisService } from '../redis/redis.service';

import {
  FINDER_HEADERS,
  SheetsService,
  SheetsUnavailableError,
  findColumns,
  firstEmptyColumn,
  rowAddress,
  text,
  type Columns,
  type Row,
} from './sheets.service';
import { a1, columnLetter, extractEmail, nationalDigits, normalizeHeader } from './sheets.util';

const WORKER_SEEN_KEY = 'email-finder:worker:last-seen';
const WORKER_ONLINE_MS = 2 * 60_000;
const CLAIM_TIMEOUT_MS = 20 * 60_000;
const MAX_ATTEMPTS = 3;
const FLUSH_DELAY_MS = 15_000;
const FINAL = ['FOUND', 'CONTACT_FORM', 'NOT_FOUND', 'FAILED'];
const RECENT_FINDS = 5;

export interface FinderRowInput {
  title: string;
  website: string;
  address: string;
  phone: string;
  category: string;
  facebook: string;
  instagram: string;
  sharedDomainCount: number;
}

export interface FinderResult {
  id: string;
  status: 'FOUND' | 'CONTACT_FORM' | 'NOT_FOUND' | 'FAILED' | 'RETRY';
  leaseToken: string;
  retryAfter?: number;
  researchComplete?: boolean;
  email?: string | null;
  emailType?: string | null;
  confidence?: number | null;
  sourceUrl?: string | null;
  decisionMaker?: string | null;
  contactFormUrl?: string | null;
  notes?: string | null;
  method?: string | null;
  enrichment?: Record<string, string> | null;
}

/** Details the finder verified for a row's empty cells, by sheet column. */
const ENRICHMENT_COLUMNS = [
  ['websiteUrl', 'website'],
  ['phoneNumber', 'phone'],
  ['facebookUrl', 'facebook'],
  ['instagramUrl', 'instagram'],
  ['youtubeUrl', 'youtube'],
  ['twitterUrl', 'twitter'],
  ['linkedinUrl', 'linkedin'],
  ['tiktokUrl', 'tiktok'],
] as const;

/** Known columns only; links must be http(s), phone numbers phone-shaped. */
export function cleanEnrichment(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== 'object') return null;
  const out: Record<string, string> = {};
  for (const [key] of ENRICHMENT_COLUMNS) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value !== 'string') continue;
    const v = value.trim();
    if (key === 'phoneNumber' ? /^\+?[\d\s().-]{7,40}$/.test(v) : /^https?:\/\/\S+$/i.test(v)) {
      out[key] = v.slice(0, 1000);
    }
  }
  return Object.keys(out).length ? out : null;
}

@Injectable()
export class EmailFinderService implements OnModuleDestroy, OnModuleInit {
  private readonly logger = new Logger(EmailFinderService.name);
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly flushing = new Map<string, Promise<void>>();

  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly starts = new Map<string, Promise<EmailFinderStatusDto>>();

  onModuleInit(): void {
    void this.recover();
    this.recoveryTimer = setInterval(() => void this.recover(), 60_000);
    this.recoveryTimer.unref?.();
  }

  private async recover(): Promise<void> {
    try {
      const pending = await this.prisma.emailFinderRow.findMany({
        where: { writtenAt: null, status: { in: FINAL }, job: { status: { not: 'CANCELLED' } } },
        distinct: ['jobId'],
        select: { jobId: true },
        take: 100,
      });
      for (const row of pending) this.scheduleFlush(row.jobId, 100);
    } catch {
      this.logger.warn('Email finder recovery unavailable; retrying in one minute.');
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly sheets: SheetsService,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleDestroy(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    for (const t of this.flushTimers.values()) clearTimeout(t);
  }

  // ── Dial page ─────────────────────────────────────────────────────────────

  /** Queue a tab's rows that have no email yet; safe to call on every selection. */
  start(userId: string, spreadsheetId: string, sheetTitle: string): Promise<EmailFinderStatusDto> {
    const key = JSON.stringify([userId, spreadsheetId, sheetTitle]);
    const existing = this.starts.get(key);
    if (existing) return existing;
    const run = this.startTab(userId, spreadsheetId, sheetTitle).finally(() =>
      this.starts.delete(key),
    );
    this.starts.set(key, run);
    return run;
  }

  private async startTab(
    userId: string,
    spreadsheetId: string,
    sheetTitle: string,
  ): Promise<EmailFinderStatusDto> {
    const token = await this.sheets.getAccessToken(userId);
    const rows = await this.sheets.fetchRows(token, spreadsheetId, sheetTitle);
    const cols = findColumns((rows[0] ?? []).map(normalizeHeader));
    if (cols.school === -1) {
      throw new SheetsUnavailableError(
        `"${sheetTitle}" needs a title (school name) column in row 1 for the email finder.`,
      );
    }

    const domainCounts = new Map<string, number>();
    for (const row of rows.slice(1)) {
      const host = hostOf(text(row[cols.website]));
      if (host) domainCounts.set(host, (domainCounts.get(host) ?? 0) + 1);
    }

    const queued: { fingerprint: string; input: FinderRowInput }[] = [];
    let alreadyHadEmail = 0;
    const seen = new Set<string>();
    for (const row of rows.slice(1)) {
      const title = text(row[cols.school]).trim();
      if (!title) continue;
      if (cols.email !== -1 && extractEmail(text(row[cols.email]))) {
        alreadyHadEmail++;
        continue;
      }
      const fp = fingerprint(row, cols);
      if (seen.has(fp)) continue;
      seen.add(fp);
      const website = text(row[cols.website]).trim();
      queued.push({
        fingerprint: fp,
        input: {
          title,
          website,
          address: rowAddress(row, cols) ?? '',
          phone: text(row[cols.phone]).trim(),
          category: text(row[cols.category]).trim(),
          facebook: text(row[cols.facebook]).trim(),
          instagram: text(row[cols.instagram]).trim(),
          sharedDomainCount: domainCounts.get(hostOf(website)) ?? 1,
        },
      });
    }

    const job = await this.prisma.emailFinderJob.upsert({
      where: { userId_spreadsheetId_sheetTitle: { userId, spreadsheetId, sheetTitle } },
      create: { userId, spreadsheetId, sheetTitle },
      update: {},
    });
    if (job.status === 'DONE') {
      await this.prisma.emailFinderJob.update({
        where: { id: job.id },
        data: { status: 'RUNNING', finishedAt: null },
      });
    }
    // Create the output columns as soon as a sheet is selected, even if no address is found.
    await this.writeToSheet(job, []);

    // Upgrade pre-v2 identities in place so existing pending work remains writable.
    const existingRows = await this.prisma.emailFinderRow.findMany({
      where: { jobId: job.id },
      select: { id: true, fingerprint: true, input: true },
    });
    const fingerprints = new Set(existingRows.map((r) => r.fingerprint));
    const inputColumns = findColumns(['title', 'phone', 'website', 'address']);
    for (const row of existingRows) {
      const input = row.input as unknown as FinderRowInput;
      const upgraded = fingerprint(
        [input.title, input.phone, input.website, input.address],
        inputColumns,
      );
      if (row.fingerprint !== upgraded && !fingerprints.has(upgraded)) {
        await this.prisma.emailFinderRow.updateMany({
          where: { id: row.id, fingerprint: row.fingerprint, status: { not: 'CLAIMED' } },
          data: { fingerprint: upgraded },
        });
        fingerprints.add(upgraded);
      }
    }
    await this.prisma.emailFinderRow.updateMany({
      where: {
        jobId: job.id,
        researchComplete: false,
        status: { in: ['CONTACT_FORM', 'NOT_FOUND'] },
      },
      data: { status: 'PENDING', attempts: 0, writtenAt: null },
    });
    // A row that failed on the worker's side (an exception, or the PC running
    // out of memory) says nothing about the school: research it again.
    await this.prisma.emailFinderRow.updateMany({
      where: { jobId: job.id, status: 'FAILED', notes: { startsWith: 'error:' } },
      data: { status: 'PENDING', attempts: 0, writtenAt: null },
    });

    for (let i = 0; i < queued.length; i += 1000) {
      await this.prisma.emailFinderRow.createMany({
        data: queued.slice(i, i + 1000).map((q) => ({
          jobId: job.id,
          fingerprint: q.fingerprint,
          input: q.input as never,
        })),
        skipDuplicates: true,
      });
    }
    await this.redis.client.set(`email-finder:job:${job.id}:had-email`, String(alreadyHadEmail));
    this.scheduleFlush(job.id, 100);
    await this.finishIfComplete(job.id);
    return this.status(userId, spreadsheetId, sheetTitle);
  }

  async status(
    userId: string,
    spreadsheetId: string,
    sheetTitle: string,
  ): Promise<EmailFinderStatusDto> {
    const job = await this.prisma.emailFinderJob.findUnique({
      where: { userId_spreadsheetId_sheetTitle: { userId, spreadsheetId, sheetTitle } },
    });
    const lastSeen = await this.redis.client.get(WORKER_SEEN_KEY).catch(() => null);
    const workerOnline = Boolean(lastSeen && Date.now() - Date.parse(lastSeen) < WORKER_ONLINE_MS);
    if (!job) {
      return {
        jobId: null,
        status: null,
        total: 0,
        done: 0,
        found: 0,
        contactForms: 0,
        alreadyHadEmail: 0,
        workerOnline,
        workerLastSeen: lastSeen,
      };
    }
    const groups = await this.prisma.emailFinderRow.groupBy({
      by: ['status'],
      where: { jobId: job.id },
      _count: { _all: true },
    });
    const count = (s: string) => groups.find((g) => g.status === s)?._count._all ?? 0;
    const total = groups.reduce((n, g) => n + g._count._all, 0);
    const had = await this.redis.client
      .get(`email-finder:job:${job.id}:had-email`)
      .catch(() => null);
    const issues = await this.prisma.emailFinderRow.findMany({
      where: {
        jobId: job.id,
        notes: { not: null },
        status: { in: ['RETRY', 'FAILED', 'NOT_FOUND'] },
      },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: { input: true, notes: true },
    });
    const finds = await this.prisma.emailFinderRow.findMany({
      where: { jobId: job.id, status: 'FOUND', email: { not: null } },
      orderBy: { updatedAt: 'desc' },
      take: RECENT_FINDS,
      select: FIND_FIELDS,
    });
    return {
      jobId: job.id,
      status: job.status as EmailFinderJobStatus,
      total,
      done: FINAL.reduce((n, s) => n + count(s), 0),
      found: count('FOUND'),
      contactForms: count('CONTACT_FORM'),
      alreadyHadEmail: Number(had ?? 0),
      retrying: count('RETRY'),
      failed: count('FAILED'),
      issues: issues.map((r) => ({
        school: (r.input as unknown as FinderRowInput).title,
        note: r.notes ?? '',
      })),
      recentFinds: finds.map((r) => toFind(r, job)),
      workerOnline,
      workerLastSeen: lastSeen,
    };
  }

  async setStatus(userId: string, jobId: string, status: 'RUNNING' | 'PAUSED' | 'CANCELLED') {
    const job = await this.prisma.emailFinderJob.findFirst({ where: { id: jobId, userId } });
    if (!job) throw new NotFoundException('No email finder job with that id.');
    await this.prisma.emailFinderJob.update({ where: { id: jobId }, data: { status } });
    return this.status(userId, job.spreadsheetId, job.sheetTitle);
  }

  // ── Worker on the user's PC ───────────────────────────────────────────────

  async heartbeat(): Promise<void> {
    await this.redis.client.set(WORKER_SEEN_KEY, new Date().toISOString(), 'EX', 3600);
  }

  async claim(max: number): Promise<{ id: string; leaseToken: string; input: FinderRowInput }[]> {
    await this.heartbeat();
    await this.prisma.emailFinderRow.updateMany({
      where: { status: 'RETRY', nextAttemptAt: { lte: new Date() } },
      data: { status: 'PENDING', nextAttemptAt: null },
    });
    const stale = new Date(Date.now() - CLAIM_TIMEOUT_MS);
    // Rows a crashed or closed worker never finished go back in the queue.
    await this.prisma.emailFinderRow.updateMany({
      where: { status: 'CLAIMED', claimedAt: { lt: stale }, attempts: { lt: MAX_ATTEMPTS } },
      data: { status: 'PENDING', leaseToken: null },
    });
    await this.prisma.emailFinderRow.updateMany({
      where: { status: 'CLAIMED', claimedAt: { lt: stale }, attempts: { gte: MAX_ATTEMPTS } },
      data: { status: 'FAILED', notes: `Gave up after ${MAX_ATTEMPTS} tries.` },
    });

    const next = await this.prisma.emailFinderRow.findMany({
      where: { status: 'PENDING', job: { status: 'RUNNING' } },
      orderBy: [{ job: { updatedAt: 'desc' } }, { createdAt: 'asc' }],
      take: Math.min(Math.max(max, 1), 20),
      select: { id: true },
    });
    if (next.length === 0) return [];
    const claimedAt = new Date();
    const leaseToken = randomUUID();
    await this.prisma.emailFinderRow.updateMany({
      where: { id: { in: next.map((r) => r.id) }, status: 'PENDING' },
      data: { status: 'CLAIMED', claimedAt, leaseToken, attempts: { increment: 1 } },
    });
    const claimed = await this.prisma.emailFinderRow.findMany({
      where: { id: { in: next.map((r) => r.id) }, status: 'CLAIMED', leaseToken },
      select: { id: true, input: true },
    });
    return claimed.map((r) => ({
      id: r.id,
      leaseToken,
      input: r.input as unknown as FinderRowInput,
    }));
  }

  async submit(results: FinderResult[]): Promise<{ saved: number }> {
    await this.heartbeat();
    const jobs = new Set<string>();
    let saved = 0;
    for (const r of results) {
      if (!FINAL.includes(r.status) && r.status !== 'RETRY') continue;
      const row = await this.prisma.emailFinderRow.findFirst({
        where: {
          id: r.id,
          status: 'CLAIMED',
          leaseToken: r.leaseToken,
          job: { status: { not: 'CANCELLED' } },
        },
        select: {
          jobId: true,
          input: true,
          job: { select: { userId: true, spreadsheetId: true, sheetTitle: true } },
        },
      });
      if (!row) continue;
      const updated = await this.prisma.emailFinderRow.updateMany({
        where: { id: r.id, status: 'CLAIMED', leaseToken: r.leaseToken },
        data: {
          status: r.status,
          researchComplete: r.researchComplete === true,
          nextAttemptAt:
            r.status === 'RETRY'
              ? new Date(Date.now() + Math.min(86400, Math.max(60, r.retryAfter ?? 1800)) * 1000)
              : null,
          // Deferred work has not failed; do not consume crash retry attempts.
          ...(r.status === 'RETRY' ? { attempts: { decrement: 1 } } : {}),
          email: clip(r.email?.toLowerCase(), 254),
          emailType: clip(r.emailType, 32),
          confidence: r.confidence ?? null,
          sourceUrl: clip(r.sourceUrl, 1000),
          decisionMaker: clip(r.decisionMaker, 200),
          contactFormUrl: clip(r.contactFormUrl, 1000),
          notes: clip(r.notes, 1000),
          method: r.status === 'FOUND' ? clip(r.method, 200) : null,
          ...(cleanEnrichment(r.enrichment) ? { enrichment: cleanEnrichment(r.enrichment)! } : {}),
        },
      });
      if (!updated.count) continue;
      jobs.add(row.jobId);
      saved++;
      const email = clip(r.email?.toLowerCase(), 254);
      if (r.status === 'FOUND' && email && row.job) {
        const find = toFind(
          {
            id: r.id,
            jobId: row.jobId,
            input: row.input,
            email,
            emailType: clip(r.emailType, 32),
            confidence: r.confidence ?? null,
            method: clip(r.method, 200),
            sourceUrl: clip(r.sourceUrl, 1000),
            updatedAt: new Date(),
          },
          row.job,
        );
        this.realtime.emailFinderFound(row.job.userId, { find });
      }
    }
    for (const jobId of jobs) this.scheduleFlush(jobId);
    return { saved };
  }

  // ── Writing results into the sheet ────────────────────────────────────────

  private scheduleFlush(jobId: string, delay = FLUSH_DELAY_MS): void {
    if (this.flushTimers.has(jobId)) return;
    const timer = setTimeout(() => {
      this.flushTimers.delete(jobId);
      const prev = this.flushing.get(jobId) ?? Promise.resolve();
      const run = prev
        .then(() => this.flush(jobId))
        .catch((err: unknown) => {
          this.logger.warn(
            `Email finder sheet write failed for job ${jobId}: ${(err as Error).message}`,
          );
          this.scheduleFlush(jobId, 60_000);
        });
      this.flushing.set(jobId, run);
    }, delay);
    timer.unref?.();
    this.flushTimers.set(jobId, timer);
  }

  async flush(jobId: string): Promise<void> {
    const job = await this.prisma.emailFinderJob.findUnique({ where: { id: jobId } });
    if (!job || job.status === 'CANCELLED') return;
    const rows = await this.prisma.emailFinderRow.findMany({
      where: { jobId, writtenAt: null, status: { in: FINAL } },
    });
    const useful = rows.filter(
      (r) => r.email || r.contactFormUrl || r.decisionMaker || cleanEnrichment(r.enrichment),
    );
    if (useful.length > 0) await this.writeToSheet(job, useful);
    if (rows.length > 0) {
      await this.prisma.emailFinderRow.updateMany({
        where: { id: { in: rows.map((r) => r.id) } },
        data: { writtenAt: new Date() },
      });
    }
    await this.finishIfComplete(jobId);
  }

  private async writeToSheet(
    job: { userId: string; spreadsheetId: string; sheetTitle: string },
    results: {
      id?: string;
      fingerprint: string;
      enrichment?: unknown;
      email: string | null;
      emailType: string | null;
      sourceUrl: string | null;
      decisionMaker: string | null;
      contactFormUrl: string | null;
    }[],
  ): Promise<void> {
    const token = await this.sheets.getAccessToken(job.userId);
    const tab = (await this.sheets.fetchTabs(token, job.spreadsheetId)).find(
      (t) => t.title === job.sheetTitle,
    );
    if (!tab) throw new Error(`tab "${job.sheetTitle}" no longer exists`);
    const sheetRows = await this.sheets.fetchRows(token, job.spreadsheetId, job.sheetTitle);
    const cols = findColumns((sheetRows[0] ?? []).map(normalizeHeader));

    // Find or place the finder's five columns.
    const data: { range: string; values: string[][] }[] = [];
    const used: number[] = Object.values(cols).filter((i) => i !== -1);
    const place = (key: keyof typeof FINDER_HEADERS, current: number): number => {
      if (current !== -1) return current;
      const col = firstEmptyColumn(sheetRows, used);
      used.push(col);
      data.push({
        range: a1(job.sheetTitle, `${columnLetter(col + 1)}1`),
        values: [[FINDER_HEADERS[key]]],
      });
      return col;
    };
    const at = {
      email: place('email', cols.email),
      emailType: place('emailType', cols.emailType),
      emailSource: place('emailSource', cols.emailSource),
      decisionMaker: place('decisionMaker', cols.decisionMaker),
      contactForm: place('contactForm', cols.contactForm),
    };
    const widest = Math.max(...Object.values(at)) + 1;
    if (widest > tab.columnCount) {
      await this.sheets.appendColumns(
        token,
        job.spreadsheetId,
        tab.sheetId,
        widest - tab.columnCount,
      );
    }

    const rowByFingerprint = new Map<string, number[]>();
    sheetRows.forEach((row, i) => {
      if (i > 0 && text(row[cols.school]).trim()) {
        const fp = fingerprint(row, cols);
        rowByFingerprint.set(fp, [...(rowByFingerprint.get(fp) ?? []), i]);
      }
    });
    const rekey: { id: string; fingerprint: string }[] = [];
    const cell = (col: number, rowIdx: number, value: string) =>
      data.push({
        range: a1(job.sheetTitle, `${columnLetter(col + 1)}${rowIdx + 1}`),
        values: [[value]],
      });

    for (const r of results) {
      const indexes = rowByFingerprint.get(r.fingerprint) ?? [];
      for (const i of indexes) {
        // the row was deleted meanwhile
        const row = sheetRows[i] ?? [];
        // Never overwrite an email someone typed in while the finder ran.
        if (r.email && !extractEmail(text(row[at.email]))) {
          cell(at.email, i, r.email);
          cell(at.emailType, i, r.emailType ?? '');
          cell(at.emailSource, i, r.sourceUrl ?? '');
        }
        if (r.decisionMaker && !text(row[at.decisionMaker]).trim())
          cell(at.decisionMaker, i, r.decisionMaker);
        if (r.contactFormUrl && !text(row[at.contactForm]).trim())
          cell(at.contactForm, i, r.contactFormUrl);
        // Fill the school's details into empty cells only.
        const enrichment = cleanEnrichment(r.enrichment) ?? {};
        const updated = [...row];
        for (const [key, column] of ENRICHMENT_COLUMNS) {
          const col = cols[column];
          const value = enrichment[key];
          if (value && col !== -1 && !text(row[col]).trim()) {
            cell(col, i, value);
            updated[col] = value;
          }
        }
        // A filled-in phone or website changes the row's identity: follow it, so
        // picking the tab again doesn't research the row from scratch.
        const now = fingerprint(updated, cols);
        if (r.id && now !== r.fingerprint) rekey.push({ id: r.id, fingerprint: now });
      }
    }
    for (let i = 0; i < data.length; i += 400) {
      await this.sheets.google(
        token,
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(job.spreadsheetId)}/values:batchUpdate`,
        'write email finder results',
        { method: 'POST', body: { valueInputOption: 'RAW', data: data.slice(i, i + 400) } },
      );
    }
    for (const r of rekey) {
      // A duplicate row may already hold that identity; then the old one stays.
      await this.prisma.emailFinderRow
        .update({ where: { id: r.id }, data: { fingerprint: r.fingerprint } })
        .catch(() => undefined);
    }
  }

  private async finishIfComplete(jobId: string): Promise<void> {
    const open = await this.prisma.emailFinderRow.count({
      where: {
        jobId,
        OR: [{ status: { in: ['PENDING', 'CLAIMED', 'RETRY'] } }, { writtenAt: null }],
      },
    });
    if (open === 0) {
      await this.prisma.emailFinderJob.updateMany({
        where: { id: jobId, status: 'RUNNING' },
        data: { status: 'DONE', finishedAt: new Date() },
      });
    }
  }
}

/** Stable identity of a sheet row: name + phone + website host. */
export function fingerprint(row: Row, cols: Columns): string {
  const title = text(row[cols.school]).trim().toLowerCase().replace(/\s+/g, ' ');
  const phone = nationalDigits(text(row[cols.phone])) ?? '';
  const host = hostOf(text(row[cols.website]));
  const address = (rowAddress(row, cols) ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha1')
    .update(`${title}|${phone}|${host}|${address}`)
    .digest('hex')
    .slice(0, 20);
}

function hostOf(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed.includes('//') ? trimmed : `https://${trimmed}`).hostname
      .toLowerCase()
      .replace(/^(www|m)\./, '');
  } catch {
    return '';
  }
}

const FIND_FIELDS = {
  id: true,
  jobId: true,
  input: true,
  email: true,
  emailType: true,
  confidence: true,
  method: true,
  sourceUrl: true,
  updatedAt: true,
} as const;

function toFind(
  r: {
    id: string;
    jobId: string;
    input: unknown;
    email: string | null;
    emailType: string | null;
    confidence: number | null;
    method: string | null;
    sourceUrl: string | null;
    updatedAt: Date;
  },
  job: { spreadsheetId: string; sheetTitle: string },
): EmailFinderFindDto {
  return {
    rowId: r.id,
    jobId: r.jobId,
    spreadsheetId: job.spreadsheetId,
    sheetTitle: job.sheetTitle,
    school: (r.input as FinderRowInput | null)?.title ?? '',
    email: r.email ?? '',
    emailType: r.emailType,
    confidence: r.confidence,
    method: r.method,
    sourceUrl: r.sourceUrl,
    foundAt: r.updatedAt.toISOString(),
  };
}

function clip(value: string | null | undefined, max: number): string | null {
  const v = value?.trim();
  return v ? v.slice(0, max) : null;
}
