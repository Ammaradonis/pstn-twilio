/**
 * The Meta-ad email sequence (see meta-ad-sequence.ts for the emails).
 *
 * Every school the Meta ads worker matched to an ad gets one 6-email sequence,
 * started as soon as its evidence arrives: an upload kicks a sweep, and a
 * sweep also runs every few minutes. Unlike the call-status sequences there is
 * no "emailed in the last 30 days" check: a school gets this sequence whether
 * or not it was called or emailed before. Three guards stay:
 *   - a school that wrote back to any earlier follow-up is skipped (it's a
 *     conversation now, or a "stop"), and a reply to this one ends it;
 *   - no email lands within 20 hours of another email to the same address,
 *     from this sequence or a call-status one;
 *   - emails go out in the school's own 8:00–19:00.
 *
 * The schedule lives in meta_ad_outreach, so it survives restarts and
 * deploys; the claim is a conditional update, so two machines never send the
 * same email.
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, type MetaAdOutreach } from '@prisma/client';
import type { MetaAdOutreachSummaryDto } from '@pstn-twilio/shared';

import { PrismaService } from '../prisma/prisma.service';

import { nameKey, schoolKey } from './facebook-url';
import { MIN_GAP_MS } from './follow-up-sequences';
import { regionFor, rowRecord, type RowData } from './follow-up-vars';
import { GmailService } from './gmail.service';
import {
  buildMetaVars,
  inSendWindow,
  isRunning,
  loadMetaSequence,
  META_SEQUENCE_LENGTH,
  metaDueAt,
  renderMetaEmail,
  type AdFacts,
} from './meta-ad-sequence';
import { cleanProfile } from './school-profile';
import { SheetsTimezoneService } from './sheets-timezone.service';
import { SheetsConfig } from './sheets.config';
import { findColumns, SheetsService, text } from './sheets.service';
import {
  extractEmails,
  joinRecipients,
  mergeRecipients,
  nationalDigits,
  normalizeHeader,
  sharesRecipient,
} from './sheets.util';

const SWEEP_MS = 5 * 60_000;
const KICK_MS = 5_000;
const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = 30 * 60_000;
const STUCK_SENDING_MS = 15 * 60_000;
// No address yet: look again after the email finder has had time to work.
const RECHECK_MS = 6 * 60 * 60_000;
// First emails per rolling day, to keep the Gmail account's sending healthy.
export const MAX_FIRST_EMAILS_PER_DAY = 80;
const DAY_MS = 24 * 60 * 60_000;

type EvidenceRow = {
  spreadsheetId: string;
  sheetId: number;
  sheetTitle: string;
  schoolTitle: string;
  facebookUrl: string;
  advertiserName: string;
  adId: string;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  observedAt: Date;
  adText: string | null;
  adCta: string | null;
  adLink: string | null;
};

export type PlannedAd = AdFacts & { schoolFacebookUrl: string };

export interface PlannedSchool {
  spreadsheetId: string;
  sheetId: number;
  sheetTitle: string;
  schoolTitle: string;
  /** schoolKey(title, facebookUrl), as the filter groups evidence. */
  key: string;
  ad: PlannedAd;
}

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * The ad a school's emails talk about: its newest running ad, else its most
 * recently ended one. Grouped per tab and school, as the filter groups them.
 */
export function pickAds(evidence: readonly EvidenceRow[], now: Date): Map<string, PlannedSchool> {
  const groups = new Map<string, EvidenceRow[]>();
  for (const e of evidence) {
    const key = `${e.spreadsheetId}|${e.sheetId}|${schoolKey(e.schoolTitle, e.facebookUrl)}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const out = new Map<string, PlannedSchool>();
  for (const [key, list] of groups) {
    const facts = (e: EvidenceRow): PlannedAd => ({
      adId: e.adId,
      advertiserName: e.advertiserName,
      status: e.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE',
      startedAt: iso(e.startedAt),
      endedAt: iso(e.endedAt),
      observedAt: e.observedAt.toISOString(),
      adText: e.adText,
      adCta: e.adCta,
      adLink: e.adLink,
      adCount: new Set(list.map((x) => x.adId)).size,
      schoolFacebookUrl: e.facebookUrl,
    });
    const time = (d: Date | null) => d?.getTime() ?? 0;
    const running = list
      .filter((e) =>
        isRunning(
          { status: e.status as AdFacts['status'], observedAt: e.observedAt.toISOString() },
          now,
        ),
      )
      .sort(
        (a, b) =>
          time(b.startedAt) - time(a.startedAt) ||
          Number(Boolean(b.adText)) - Number(Boolean(a.adText)),
      );
    const ended = [...list].sort(
      (a, b) =>
        time(b.endedAt ?? b.observedAt) - time(a.endedAt ?? a.observedAt) ||
        Number(Boolean(b.adText)) - Number(Boolean(a.adText)),
    );
    const best = running[0] ?? ended[0]!;
    out.set(key, {
      spreadsheetId: best.spreadsheetId,
      sheetId: best.sheetId,
      sheetTitle: best.sheetTitle,
      schoolTitle: best.schoolTitle,
      key: schoolKey(best.schoolTitle, best.facebookUrl),
      ad: facts(best),
    });
  }
  return out;
}

@Injectable()
export class MetaAdOutreachService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MetaAdOutreachService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private kickTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sheets: SheetsService,
    private readonly gmail: GmailService,
    private readonly timezones: SheetsTimezoneService,
    private readonly cfg: SheetsConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref?.();
    this.kick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.kickTimer) clearTimeout(this.kickTimer);
  }

  /** New evidence arrived: start its sequences now rather than at the next sweep. */
  kick(): void {
    if (this.kickTimer) return;
    this.kickTimer = setTimeout(() => {
      this.kickTimer = null;
      void this.sweep();
    }, KICK_MS);
    this.kickTimer.unref?.();
  }

  async sweep(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.plan(now);
      await this.findAddresses(now);
      await this.prisma.metaAdOutreach.updateMany({
        where: { status: 'SENDING', updatedAt: { lt: new Date(now.getTime() - STUCK_SENDING_MS) } },
        data: {
          status: 'FAILED',
          error: 'Interrupted while sending; check the Gmail Sent folder before resending.',
        },
      });
      const due = await this.prisma.metaAdOutreach.findMany({
        where: { status: 'PENDING', emailTo: { not: null }, dueAt: { lte: now } },
        orderBy: { dueAt: 'asc' },
        take: 20,
      });
      for (const row of due) await this.send(row, now);
    } catch (err) {
      this.logger.error(`Meta-ad sequence sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  // ── Planning ──────────────────────────────────────────────────────────────

  /** One sequence per school with evidence that doesn't have one yet. */
  private async plan(now: Date): Promise<void> {
    const evidence = await this.prisma.metaAdEvidence.findMany({
      select: {
        spreadsheetId: true,
        sheetId: true,
        sheetTitle: true,
        schoolTitle: true,
        facebookUrl: true,
        advertiserName: true,
        adId: true,
        status: true,
        startedAt: true,
        endedAt: true,
        observedAt: true,
        adText: true,
        adCta: true,
        adLink: true,
      },
    });
    if (evidence.length === 0) return;
    const schools = pickAds(evidence, now);
    const existing = await this.prisma.metaAdOutreach.findMany({
      select: {
        id: true,
        spreadsheetId: true,
        sheetId: true,
        schoolKey: true,
        status: true,
        ad: true,
      },
    });
    const have = new Map(
      existing.map((o) => [`${o.spreadsheetId}|${o.sheetId}|${o.schoolKey}`, o]),
    );
    const owners = new Map<string, string | null>();
    const create: Prisma.MetaAdOutreachCreateManyInput[] = [];
    for (const [key, school] of schools) {
      const known = have.get(key);
      if (known) {
        // Still waiting for an address: talk about the newest ad when the first email goes.
        if (
          known.status === 'WAITING_EMAIL' &&
          (known.ad as { adId?: string } | null)?.adId !== school.ad.adId
        ) {
          await this.prisma.metaAdOutreach.update({
            where: { id: known.id },
            data: { ad: school.ad as unknown as Prisma.InputJsonValue },
          });
        }
        continue;
      }
      if (!owners.has(school.spreadsheetId)) {
        owners.set(school.spreadsheetId, await this.ownerOf(school.spreadsheetId));
      }
      const userId = owners.get(school.spreadsheetId);
      if (!userId) continue;
      create.push({
        userId,
        spreadsheetId: school.spreadsheetId,
        sheetId: school.sheetId,
        sheetTitle: school.sheetTitle,
        schoolTitle: school.schoolTitle,
        schoolKey: school.key,
        status: 'WAITING_EMAIL',
        ad: school.ad as unknown as Prisma.InputJsonValue,
        timeZone: 'America/Chicago',
        checkAt: now,
      });
    }
    if (create.length) {
      const { count } = await this.prisma.metaAdOutreach.createMany({
        data: create,
        skipDuplicates: true,
      });
      this.logger.log(`Meta-ad sequence: ${count} new school${count === 1 ? '' : 's'} to email.`);
    }
  }

  /**
   * Whose Gmail sends for this spreadsheet: the only Google connection, or the
   * connected user who works this spreadsheet. Never a guess between two.
   */
  private async ownerOf(spreadsheetId: string): Promise<string | null> {
    const connections = await this.prisma.googleSheetsConnection.findMany({
      select: { userId: true },
    });
    if (connections.length === 1) return connections[0]!.userId;
    const users = new Set(connections.map((c) => c.userId));
    const jobs = await this.prisma.emailFinderJob.findMany({
      where: { spreadsheetId, userId: { in: [...users] } },
      select: { userId: true },
      distinct: ['userId'],
    });
    if (jobs.length === 1) return jobs[0]!.userId;
    this.logger.warn(
      `Meta-ad sequence: ${connections.length} Google connections and no single owner for spreadsheet ${spreadsheetId}; not emailing its advertisers.`,
    );
    return null;
  }

  // ── Addresses ─────────────────────────────────────────────────────────────

  private async findAddresses(now: Date): Promise<void> {
    const waiting = await this.prisma.metaAdOutreach.findMany({
      where: { status: 'WAITING_EMAIL', OR: [{ checkAt: null }, { checkAt: { lte: now } }] },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    const tabs = new Map<string, MetaAdOutreach[]>();
    for (const o of waiting) {
      const key = `${o.userId}|${o.spreadsheetId}|${o.sheetId}`;
      tabs.set(key, [...(tabs.get(key) ?? []), o]);
    }
    for (const list of tabs.values()) {
      try {
        await this.resolveTab(list, now);
      } catch (err) {
        const message = (err as Error).message.slice(0, 300);
        this.logger.warn(`Meta-ad sequence: reading "${list[0]!.sheetTitle}" failed: ${message}`);
        await this.prisma.metaAdOutreach.updateMany({
          where: { id: { in: list.map((o) => o.id) }, status: 'WAITING_EMAIL' },
          data: { checkAt: new Date(now.getTime() + RETRY_DELAY_MS), error: message },
        });
      }
    }
  }

  private async resolveTab(list: MetaAdOutreach[], now: Date): Promise<void> {
    const { userId, spreadsheetId, sheetId } = list[0]!;
    const token = await this.sheets.getAccessToken(userId);
    // The tab may have been renamed since the match: its id is the key.
    const tab = (await this.sheets.fetchTabs(token, spreadsheetId)).find(
      (t) => t.sheetId === sheetId,
    );
    if (!tab) {
      await this.prisma.metaAdOutreach.updateMany({
        where: { id: { in: list.map((o) => o.id) } },
        data: { status: 'SKIPPED', error: 'The tab no longer exists.' },
      });
      return;
    }
    const rows = await this.sheets.fetchRows(token, spreadsheetId, tab.title);
    const header = (rows[0] ?? []).map(normalizeHeader);
    const cols = findColumns(header);
    const byName = new Map<string, RowData[]>();
    for (const row of rows.slice(1)) {
      const title = cols.school === -1 ? '' : text(row[cols.school]).trim();
      if (!title) continue;
      const record = rowRecord(header, row);
      byName.set(nameKey(title), [...(byName.get(nameKey(title)) ?? []), record]);
    }
    const finder = await this.finderFacts(userId, spreadsheetId, tab.title);

    for (const o of list) {
      const ad = o.ad as unknown as PlannedAd;
      const candidates = byName.get(nameKey(o.schoolTitle)) ?? [];
      // Two rows with one name: the one whose page is the matched page.
      const row =
        candidates.find(
          (r) =>
            ad.schoolFacebookUrl && schoolKey(o.schoolTitle, r.facebookurl ?? '') === o.schoolKey,
        ) ?? candidates[0];
      if (!row) {
        await this.prisma.metaAdOutreach.update({
          where: { id: o.id },
          data: {
            checkAt: new Date(now.getTime() + DAY_MS),
            error: `"${o.schoolTitle}" is no longer in "${tab.title}".`,
          },
        });
        continue;
      }
      const facts = finder.get(nameKey(o.schoolTitle));
      const recipients = mergeRecipients(
        extractEmails(row.email ?? row.emailaddress ?? ''),
        facts?.emails ?? [],
      );
      const phone = row.phonenumber ?? row.phone ?? '';
      const region = regionFor(
        { spreadsheetId, destinationE164: phone.trim().startsWith('+44') ? '+44' : '' },
        { usSheetId: this.cfg.conquestSheetId, ukSheetId: this.cfg.ukSheetId },
      );
      const national = nationalDigits(phone) ?? '';
      const e164 = region === 'UK' ? `+44${national.replace(/^0/, '')}` : `+1${national}`;
      const { timeZone } = await this.timezones.resolve(row.address ?? null, e164);
      const common = {
        sheetTitle: tab.title,
        rowData: row as unknown as Prisma.InputJsonValue,
        ...(facts?.profile ? { profile: facts.profile as unknown as Prisma.InputJsonValue } : {}),
        timeZone,
      };
      if (recipients.length === 0) {
        await this.prisma.metaAdOutreach.update({
          where: { id: o.id },
          data: { ...common, checkAt: new Date(now.getTime() + RECHECK_MS), error: null },
        });
        continue;
      }
      const to = joinRecipients(recipients)!;
      const earlier = await this.prisma.sheetsPushLog.findMany({
        where: {
          connection: { userId },
          OR: recipients.map((address) => ({
            emailTo: { contains: address, mode: 'insensitive' as const },
          })),
        },
        select: { emailTo: true, emailStatus: true, emailSentAt: true },
        take: 50,
      });
      const shared = earlier.filter((e) => sharesRecipient(e.emailTo, recipients));
      if (shared.some((e) => e.emailStatus === 'REPLIED')) {
        await this.prisma.metaAdOutreach.update({
          where: { id: o.id },
          data: {
            ...common,
            emailTo: to,
            status: 'SKIPPED',
            error: 'They already replied to an earlier follow-up; answer them by hand.',
          },
        });
        continue;
      }
      await this.prisma.metaAdOutreach.update({
        where: { id: o.id },
        data: {
          ...common,
          emailTo: to,
          status: 'PENDING',
          dueAt: this.spaced(inSendWindow(now, timeZone), shared, timeZone),
          error: null,
        },
      });
    }
  }

  /** `at`, moved past 20 hours after the last email any sequence sent to the same address. */
  private spaced(at: Date, shared: { emailSentAt: Date | null }[], timeZone: string): Date {
    const last = Math.max(0, ...shared.map((e) => e.emailSentAt?.getTime() ?? 0));
    return last + MIN_GAP_MS > at.getTime()
      ? inSendWindow(new Date(last + MIN_GAP_MS), timeZone)
      : at;
  }

  /** Addresses and profiles the email finder has for this tab's schools, by school name. */
  private async finderFacts(
    userId: string,
    spreadsheetId: string,
    sheetTitle: string,
  ): Promise<Map<string, { emails: string[]; profile: unknown }>> {
    const out = new Map<string, { emails: string[]; profile: unknown }>();
    const rows = await this.prisma.emailFinderRow.findMany({
      where: {
        job: { userId, spreadsheetId, sheetTitle },
        OR: [{ status: 'FOUND', email: { not: null } }, { profile: { not: Prisma.DbNull } }],
      },
      orderBy: { updatedAt: 'desc' },
      select: { input: true, email: true, status: true, profile: true },
      take: 5000,
    });
    for (const r of rows) {
      const title = (r.input as { title?: string } | null)?.title ?? '';
      if (!title) continue;
      const key = nameKey(title);
      const entry = out.get(key) ?? { emails: [], profile: null };
      if (r.status === 'FOUND')
        entry.emails = mergeRecipients(entry.emails, extractEmails(r.email));
      if (!entry.profile) entry.profile = cleanProfile(r.profile);
      out.set(key, entry);
    }
    return out;
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  private async send(o: MetaAdOutreach, now: Date): Promise<void> {
    if (o.step === 1) {
      const started = await this.prisma.metaAdOutreach.count({
        where: { firstSentAt: { gte: new Date(now.getTime() - DAY_MS) } },
      });
      if (started >= MAX_FIRST_EMAILS_PER_DAY) {
        await this.prisma.metaAdOutreach.updateMany({
          where: { id: o.id, status: 'PENDING' },
          data: { dueAt: inSendWindow(new Date(now.getTime() + 60 * 60_000), o.timeZone) },
        });
        return;
      }
    }
    const claimed = await this.prisma.metaAdOutreach.updateMany({
      where: { id: o.id, status: 'PENDING' },
      data: { status: 'SENDING', attempts: { increment: 1 } },
    });
    if (claimed.count === 0 || !o.emailTo) return;

    try {
      if (o.firstSentAt && (await this.replied(o))) {
        await this.prisma.metaAdOutreach.update({
          where: { id: o.id },
          data: { status: 'REPLIED', error: null },
        });
        this.logger.log(`Meta-ad sequence for "${o.schoolTitle}" stopped: ${o.emailTo} replied`);
        return;
      }
      const region = regionFor(
        {
          spreadsheetId: o.spreadsheetId,
          destinationE164: o.timeZone === 'Europe/London' ? '+44' : '',
        },
        { usSheetId: this.cfg.conquestSheetId, ukSheetId: this.cfg.ukSheetId },
      );
      const vars = buildMetaVars({
        row: (o.rowData ?? {}) as RowData,
        schoolTitle: o.schoolTitle,
        sheetTitle: o.sheetTitle,
        ad: o.ad as unknown as AdFacts,
        profile: cleanProfile(o.profile),
        region,
        now,
      });
      const email = renderMetaEmail(loadMetaSequence()[o.step - 1]!, vars);
      await this.gmail.send(o.userId, o.emailTo, email.subject, email.body);
      const sentAt = new Date();
      const firstSentAt = o.firstSentAt ?? sentAt;
      const next = o.step + 1;
      await this.prisma.metaAdOutreach.update({
        where: { id: o.id },
        data: {
          ...(next <= META_SEQUENCE_LENGTH
            ? {
                status: 'PENDING',
                step: next,
                dueAt: metaDueAt(firstSentAt, next, sentAt, o.timeZone),
              }
            : { status: 'SENT', dueAt: null }),
          firstSentAt,
          lastSentAt: sentAt,
          emailsSent: { increment: 1 },
          attempts: 0,
          error: null,
        },
      });
      this.logger.log(
        `Meta-ad email ${o.step}/${META_SEQUENCE_LENGTH} sent to "${o.schoolTitle}" (${region})`,
      );
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      const attempts = o.attempts + 1;
      await this.prisma.metaAdOutreach.update({
        where: { id: o.id },
        data:
          attempts < MAX_ATTEMPTS
            ? {
                status: 'PENDING',
                dueAt: new Date(now.getTime() + RETRY_DELAY_MS * attempts),
                error: message,
              }
            : { status: 'FAILED', error: message },
      });
      this.logger.warn(
        `Meta-ad email for "${o.schoolTitle}" failed (attempt ${attempts}): ${message}`,
      );
    }
  }

  private async replied(o: MetaAdOutreach): Promise<boolean> {
    try {
      return (await this.gmail.hasReplyFrom(o.userId, o.emailTo!, o.firstSentAt!)) === true;
    } catch (err) {
      this.logger.warn(`Reply check for "${o.schoolTitle}" failed: ${(err as Error).message}`);
      return false;
    }
  }

  // ── Status for the Dial page ──────────────────────────────────────────────

  async summary(spreadsheetId: string, sheetId: number): Promise<MetaAdOutreachSummaryDto> {
    const rows = await this.prisma.metaAdOutreach.findMany({
      where: { spreadsheetId, sheetId },
      select: { status: true, emailsSent: true },
    });
    const count = (...statuses: string[]) => rows.filter((r) => statuses.includes(r.status)).length;
    return {
      started: rows.filter((r) => r.emailsSent > 0).length,
      queued: rows.filter((r) => r.status === 'PENDING' && r.emailsSent === 0).length,
      waitingForEmail: count('WAITING_EMAIL'),
      finished: count('SENT'),
      replied: count('REPLIED'),
      stopped: count('FAILED', 'SKIPPED'),
      emailsSent: rows.reduce((sum, r) => sum + r.emailsSent, 0),
    };
  }
}
