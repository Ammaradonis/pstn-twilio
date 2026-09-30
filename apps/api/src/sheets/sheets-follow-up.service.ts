/**
 * Sends follow-up cold emails once they are due.
 *
 * The schedule lives in sheets_push_logs (emailStatus PENDING + emailDueAt),
 * so it survives restarts and deploys. A sweep every few minutes claims due
 * rows one at a time (PENDING → SENDING) and sends them; the claim is a
 * conditional update, so two machines never send the same email.
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { GmailService } from './gmail.service';
import { formatLocalTime, formatLocalWeekday, stripCountryCode } from './sheets.util';

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
        where: { emailStatus: 'PENDING', emailDueAt: { lte: now } },
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
      await this.gmail.sendFromTemplate(log.connection.userId, log.emailTo, log.emailTemplate, {
        schoolName: log.schoolName ?? '',
        customNote: log.customNote ?? '',
        callerNumber: stripCountryCode(log.callerE164),
        phoneNumber: stripCountryCode(log.destinationE164),
        callDay: formatLocalWeekday(log.callEndedAt, log.timeZone),
        localTime: formatLocalTime(log.callEndedAt, log.timeZone),
      });
      await this.prisma.sheetsPushLog.update({
        where: { id: log.id },
        data: { emailStatus: 'SENT', emailSentAt: new Date(), emailError: null },
      });
      this.logger.log(`Follow-up email ${log.emailTemplate} sent for push ${log.id}`);
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
}
