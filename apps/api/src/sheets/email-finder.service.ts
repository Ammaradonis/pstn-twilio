/**
 * Email finder queue.
 *
 * Picking a tab on the Dial page queues every row that has no email yet.
 * The worker on the user's PC (workers/email-finder) claims rows, researches
 * them and posts results back; results are written into the tab in batches:
 * email, emailType, emailSource, decisionMaker and contactForm columns
 * (created next to the data if missing). Rows are matched by a fingerprint of
 * name + phone + website, so sorting or inserting rows mid-run is safe, and a
 * row that already has an email is never overwritten.
 */

import { createHash } from 'crypto';

import { Injectable, Logger, NotFoundException, OnModuleDestroy } from '@nestjs/common';
import type { EmailFinderJobStatus, EmailFinderStatusDto } from '@pstn-twilio/shared';

import { PrismaService } from '../prisma/prisma.service';
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
  status: 'FOUND' | 'CONTACT_FORM' | 'NOT_FOUND' | 'FAILED';
  email?: string | null;
  emailType?: string | null;
  confidence?: number | null;
  sourceUrl?: string | null;
  decisionMaker?: string | null;
  contactFormUrl?: string | null;
  notes?: string | null;
}

@Injectable()
export class EmailFinderService implements OnModuleDestroy {
  private readonly logger = new Logger(EmailFinderService.name);
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly flushing = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sheets: SheetsService,
    private readonly redis: RedisService,
  ) {}

  onModuleDestroy(): void {
    for (const t of this.flushTimers.values()) clearTimeout(t);
  }

  // ── Dial page ─────────────────────────────────────────────────────────────

  /** Queue a tab's rows that have no email yet; safe to call on every selection. */
  async start(
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

    const existing = await this.prisma.emailFinderJob.findUnique({
      where: { userId_spreadsheetId_sheetTitle: { userId, spreadsheetId, sheetTitle } },
    });
    const job = existing
      ? await this.prisma.emailFinderJob.update({
          where: { id: existing.id },
          // Re-selecting a finished tab picks up rows added since; a paused
          // tab stays paused. Touching updatedAt puts this tab first in line.
          data: { status: existing.status === 'PAUSED' ? 'PAUSED' : 'RUNNING', finishedAt: null },
        })
      : await this.prisma.emailFinderJob.create({ data: { userId, spreadsheetId, sheetTitle } });

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
    return {
      jobId: job.id,
      status: job.status as EmailFinderJobStatus,
      total,
      done: FINAL.reduce((n, s) => n + count(s), 0),
      found: count('FOUND'),
      contactForms: count('CONTACT_FORM'),
      alreadyHadEmail: Number(had ?? 0),
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

  async claim(max: number): Promise<{ id: string; input: FinderRowInput }[]> {
    await this.heartbeat();
    const stale = new Date(Date.now() - CLAIM_TIMEOUT_MS);
    // Rows a crashed or closed worker never finished go back in the queue.
    await this.prisma.emailFinderRow.updateMany({
      where: { status: 'CLAIMED', claimedAt: { lt: stale }, attempts: { lt: MAX_ATTEMPTS } },
      data: { status: 'PENDING' },
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
    await this.prisma.emailFinderRow.updateMany({
      where: { id: { in: next.map((r) => r.id) }, status: 'PENDING' },
      data: { status: 'CLAIMED', claimedAt, attempts: { increment: 1 } },
    });
    const claimed = await this.prisma.emailFinderRow.findMany({
      where: { id: { in: next.map((r) => r.id) }, status: 'CLAIMED', claimedAt },
      select: { id: true, input: true },
    });
    return claimed.map((r) => ({ id: r.id, input: r.input as unknown as FinderRowInput }));
  }

  async submit(results: FinderResult[]): Promise<{ saved: number }> {
    await this.heartbeat();
    const jobs = new Set<string>();
    let saved = 0;
    for (const r of results) {
      if (!FINAL.includes(r.status)) continue;
      const row = await this.prisma.emailFinderRow.findFirst({
        where: { id: r.id, status: 'CLAIMED' },
        select: { jobId: true },
      });
      if (!row) continue;
      await this.prisma.emailFinderRow.update({
        where: { id: r.id },
        data: {
          status: r.status,
          email: clip(r.email?.toLowerCase(), 254),
          emailType: clip(r.emailType, 32),
          confidence: r.confidence ?? null,
          sourceUrl: clip(r.sourceUrl, 1000),
          decisionMaker: clip(r.decisionMaker, 200),
          contactFormUrl: clip(r.contactFormUrl, 1000),
          notes: clip(r.notes, 1000),
        },
      });
      jobs.add(row.jobId);
      saved++;
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
    if (!job) return;
    const rows = await this.prisma.emailFinderRow.findMany({
      where: { jobId, writtenAt: null, status: { in: FINAL } },
    });
    const useful = rows.filter((r) => r.email || r.contactFormUrl || r.decisionMaker);
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
      fingerprint: string;
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

    const rowByFingerprint = new Map<string, number>();
    sheetRows.forEach((row, i) => {
      if (i > 0 && text(row[cols.school]).trim()) rowByFingerprint.set(fingerprint(row, cols), i);
    });
    const cell = (col: number, rowIdx: number, value: string) =>
      data.push({
        range: a1(job.sheetTitle, `${columnLetter(col + 1)}${rowIdx + 1}`),
        values: [[value]],
      });

    for (const r of results) {
      const i = rowByFingerprint.get(r.fingerprint);
      if (i === undefined) continue; // the row was deleted meanwhile
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
    }
    for (let i = 0; i < data.length; i += 400) {
      await this.sheets.google(
        token,
        `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(job.spreadsheetId)}/values:batchUpdate`,
        'write email finder results',
        { method: 'POST', body: { valueInputOption: 'RAW', data: data.slice(i, i + 400) } },
      );
    }
  }

  private async finishIfComplete(jobId: string): Promise<void> {
    const open = await this.prisma.emailFinderRow.count({
      where: { jobId, OR: [{ status: { in: ['PENDING', 'CLAIMED'] } }, { writtenAt: null }] },
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
  return createHash('sha1').update(`${title}|${phone}|${host}`).digest('hex').slice(0, 20);
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

function clip(value: string | null | undefined, max: number): string | null {
  const v = value?.trim();
  return v ? v.slice(0, max) : null;
}
