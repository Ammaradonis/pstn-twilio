/**
 * Sends the follow-up sequences: 6 emails per push, on the days in
 * SEQUENCE_DAYS after the call.
 *
 * The schedule lives in sheets_push_logs (emailStatus PENDING, emailDueAt and
 * sequenceStep), so it survives restarts and deploys. A sweep every few
 * minutes claims due rows one at a time (PENDING → SENDING) and sends the
 * next email; the claim is a conditional update, so two machines never send
 * the same email. After email 6 the row is SENT.
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { FollowUpRenderer } from './follow-up-renderer.service';
import { SEQUENCE_LENGTH, sequenceDueAt } from './follow-up-sequences';
import { GmailService } from './gmail.service';
import { nationalDigits } from './sheets.util';

const SWEEP_MS = 5 * 60_000;
const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = 30 * 60_000;
// A row stuck in SENDING means the process died mid-send. The email may have
// gone out, so it is marked failed rather than retried (no double emails).
const STUCK_SENDING_MS = 15 * 60_000;

@Injectable()
export class SheetsFollowUpService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SheetsFollowUpService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gmail: GmailService,
    private readonly renderer: FollowUpRenderer,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.resolveResearch();
      await this.prisma.sheetsPushLog.updateMany({
        where: {
          emailStatus: 'SENDING',
          updatedAt: { lt: new Date(now.getTime() - STUCK_SENDING_MS) },
        },
        data: {
          emailStatus: 'FAILED',
          emailError: 'Interrupted while sending; check the Gmail Sent folder before resending.',
        },
      });

      const due = await this.prisma.sheetsPushLog.findMany({
        where: { emailStatus: 'PENDING', emailTo: { not: null }, emailDueAt: { lte: now } },
        orderBy: { emailDueAt: 'asc' },
        take: 20,
        include: { connection: { select: { userId: true } } },
      });
      for (const log of due) await this.send(log, now);
    } catch (err) {
      this.logger.error(`Follow-up sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async resolveResearch(): Promise<void> {
    const waiting = await this.prisma.sheetsPushLog.findMany({
      where: { emailStatus: 'WAITING_RESEARCH' },
      take: 100,
      orderBy: { createdAt: 'asc' },
      include: { connection: { select: { userId: true } } },
    });
    for (const log of waiting) {
      const rows = await this.prisma.emailFinderRow.findMany({
        where: {
          job: {
            userId: log.connection.userId,
            spreadsheetId: log.spreadsheetId,
            sheetTitle: log.sheetTitle,
          },
        },
        select: {
          input: true,
          status: true,
          email: true,
          contactFormUrl: true,
          researchComplete: true,
        },
      });
      const matches = rows.filter((r) => {
        const input = r.input as { phone?: string; title?: string };
        return (
          nationalDigits(input.phone ?? '') === nationalDigits(log.destinationE164) &&
          (!log.schoolName ||
            input.title?.toLowerCase().trim() === log.schoolName.toLowerCase().trim())
        );
      });
      const found =
        matches.find((r) => r.status === 'FOUND' && r.email) ??
        matches.find((r) => r.researchComplete && r.status === 'CONTACT_FORM' && r.contactFormUrl);
      if (!found) {
        if (matches.length && matches.every((r) => ['NOT_FOUND', 'FAILED'].includes(r.status))) {
          await this.prisma.sheetsPushLog.updateMany({
            where: { id: log.id, emailStatus: 'WAITING_RESEARCH' },
            data: {
              emailStatus: 'NONE',
              emailError: 'Research finished without a usable contact.',
            },
          });
        }
        continue;
      }
      const recent = await this.prisma.sheetsPushLog.findFirst({
        where: {
          connectionId: log.connectionId,
          id: { not: log.id },
          emailStatus: { in: ['PENDING', 'SENDING', 'SENT', 'FORM_PREPARING', 'FORM_SENDING'] },
          createdAt: { gte: new Date(Date.now() - 30 * 86400_000) },
          ...(found.email
            ? { emailTo: { equals: found.email, mode: 'insensitive' } }
            : { contactFormUrl: found.contactFormUrl }),
        },
        select: { id: true },
      });
      await this.prisma.sheetsPushLog.updateMany({
        where: { id: log.id, emailStatus: 'WAITING_RESEARCH' },
        data: recent
          ? { emailStatus: 'NONE', emailError: 'A recent follow-up already targets this contact.' }
          : {
              emailStatus: 'PENDING',
              emailTo: found.email,
              contactFormUrl: found.email ? null : found.contactFormUrl,
            },
      });
    }
  }

  private async send(
    log: Awaited<ReturnType<PrismaService['sheetsPushLog']['findMany']>>[number] & {
      connection: { userId: string };
    },
    now: Date,
  ): Promise<void> {
    const claimed = await this.prisma.sheetsPushLog.updateMany({
      where: { id: log.id, emailStatus: 'PENDING' },
      data: { emailStatus: 'SENDING', emailAttempts: { increment: 1 } },
    });
    if (claimed.count === 0 || !log.emailTo || !log.emailTemplate) return;

    try {
      // Once they've written back, the rest of the sequence would be noise.
      if (log.emailSentAt && (await this.replied(log))) {
        await this.prisma.sheetsPushLog.update({
          where: { id: log.id },
          data: { emailStatus: 'REPLIED', emailError: null },
        });
        this.logger.log(`Follow-up sequence for push ${log.id} stopped: ${log.emailTo} replied`);
        return;
      }
      const email = await this.renderer.render(log, log.connection.userId);
      if (!email) {
        // Nothing left that this lead has the data for.
        await this.prisma.sheetsPushLog.update({
          where: { id: log.id },
          data: log.emailSentAt
            ? { emailStatus: 'SENT', emailError: null }
            : {
                emailStatus: 'FAILED',
                emailError: 'No email in the sequence has the data it needs.',
              },
        });
        return;
      }
      await this.gmail.send(log.connection.userId, log.emailTo, email.subject, email.body);
      const sentAt = new Date();
      const next = email.step + 1;
      await this.prisma.sheetsPushLog.update({
        where: { id: log.id },
        data:
          next <= SEQUENCE_LENGTH
            ? {
                emailStatus: 'PENDING',
                sequenceStep: next,
                emailDueAt: sequenceDueAt(log.callEndedAt, next, sentAt),
                emailSentAt: sentAt,
                emailAttempts: 0,
                emailError: null,
              }
            : {
                emailStatus: 'SENT',
                sequenceStep: email.step,
                emailSentAt: sentAt,
                emailError: null,
              },
      });
      this.logger.log(
        `Follow-up "${log.emailTemplate}" email ${email.step}/${SEQUENCE_LENGTH} (${email.region}) sent for push ${log.id}`,
      );
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      const attempts = log.emailAttempts + 1;
      await this.prisma.sheetsPushLog.update({
        where: { id: log.id },
        data:
          attempts < MAX_ATTEMPTS
            ? {
                emailStatus: 'PENDING',
                emailDueAt: new Date(now.getTime() + RETRY_DELAY_MS * attempts),
                emailError: message,
              }
            : { emailStatus: 'FAILED', emailError: message },
      });
      this.logger.warn(
        `Follow-up email for push ${log.id} failed (attempt ${attempts}): ${message}`,
      );
    }
  }

  private async replied(log: {
    id: string;
    emailTo: string | null;
    callEndedAt: Date;
    connection: { userId: string };
  }): Promise<boolean> {
    if (!log.emailTo) return false;
    try {
      return (
        (await this.gmail.hasReplyFrom(log.connection.userId, log.emailTo, log.callEndedAt)) ===
        true
      );
    } catch (err) {
      // A failed check shouldn't hold the sequence back.
      this.logger.warn(`Reply check for push ${log.id} failed: ${(err as Error).message}`);
      return false;
    }
  }
}
