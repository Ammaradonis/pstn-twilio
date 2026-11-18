/**
 * The cold SMS campaign: one text per called lead, from the toll-free line.
 *
 * Leads are the calls pushed to Google Sheets (sheets_push_logs). A lead
 * gets the text when:
 *   - its number is a US/Canadian (+1) number (the toll-free line texts nowhere else),
 *   - no push for that number is tagged "Out-of-service number" or "Booked a demo",
 *   - the number never got the campaign text and has no texts with us either way
 *     (that covers anyone who texted STOP),
 *   - its latest call ended at least SETTLE_MS ago, so a corrected status lands first,
 *   - it is between 9am and 8pm in the lead's time zone (any day of the week).
 * Newest calls go first, while the call is fresh in their mind.
 *
 * A sweep every minute sends at most one text, and texts are SEND_GAP apart
 * (claimed with a conditional update, so two machines never both send). No
 * more than the daily cap go out in any 24 hours. If carriers start blocking
 * the texts, the campaign pauses itself.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { MessageDirection, MessageStatus, Prisma, type PhoneNumber } from '@prisma/client';
import {
  DEFAULT_SMS_CAMPAIGN_BODY,
  SMS_CAMPAIGN_DAILY_CAP,
  SMS_CAMPAIGN_FROM_E164,
  SMS_CAMPAIGN_HOURS,
  SMS_CAMPAIGN_SEND_GAP_MINUTES,
  renderCampaignText,
  type SmsCampaignDto,
  type SmsCampaignSendStatus,
  type SmsCampaignTestResultDto,
  type SmsCampaignUpdateInput,
} from '@pstn-twilio/shared';

import { AuditService } from '../audit/audit.service';
import { mapMessage } from '../messages/messages.mapper';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TwilioService } from '../twilio/twilio.service';

const SWEEP_MS = 60_000;
const SEND_GAP_MS = SMS_CAMPAIGN_SEND_GAP_MINUTES * 60_000;
const SETTLE_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const RECENT_LIMIT = 50;
const TEST_SCHOOL_NAME = 'Lone Star Karate';

// Twilio refusals about the one recipient: that lead is done. Any other
// refusal is about the line or the account, so the lead waits for a retry.
const OPTED_OUT_CODES = new Set([21610]);
const RECIPIENT_CODES = new Set([21211, 21612, 21614]);

// Delivery errors that mean carriers are blocking the line's texts.
const CARRIER_BLOCK_CODES = new Set(['30007', '30032', '30034']);
const BLOCK_WINDOW = 20;
const BLOCK_LIMIT = 5;

const OUT_OF_SERVICE_TAG = JSON.stringify(['Out-of-service number']);
const BOOKED_TAG = JSON.stringify(['Booked a demo']);

export interface CampaignLead {
  pushLogId: string;
  toE164: string;
  schoolName: string | null;
  timeZone: string;
  callEndedAt: Date;
}

type Delivery =
  | { ok: true; smsMessageId: string }
  | { ok: false; code: number | null; message: string };

/** The hour (0-23) in a time zone, or null for a zone this runtime doesn't know. */
export function localHour(now: Date, timeZone: string): number | null {
  try {
    const hour = Number(
      new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(now),
    );
    return Number.isInteger(hour) ? hour % 24 : null;
  } catch {
    return null;
  }
}

export function inSendingHours(now: Date, timeZone: string): boolean {
  const hour = localHour(now, timeZone);
  return hour !== null && hour >= SMS_CAMPAIGN_HOURS.start && hour < SMS_CAMPAIGN_HOURS.end;
}

@Injectable()
export class SmsCampaignService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SmsCampaignService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async get(userId: string, now = new Date()): Promise<SmsCampaignDto> {
    const [campaign, leads, sentLast24h, byStatus, byDelivery, recent] = await Promise.all([
      this.prisma.smsCampaign.findUnique({ where: { userId } }),
      this.leads(userId, now),
      this.sentSince(userId, new Date(now.getTime() - DAY_MS)),
      this.prisma.smsCampaignSend.groupBy({
        by: ['status'],
        where: { userId },
        _count: { _all: true },
      }),
      this.prisma.smsMessage.groupBy({
        by: ['status'],
        where: { campaignSend: { is: { userId } } },
        _count: { _all: true },
      }),
      this.prisma.smsCampaignSend.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: RECENT_LIMIT,
        include: { smsMessage: { select: { status: true, errorCode: true, errorMessage: true } } },
      }),
    ]);
    const statusCount = (status: SmsCampaignSendStatus) =>
      byStatus.find((row) => row.status === status)?._count._all ?? 0;
    const deliveryCount = (...statuses: MessageStatus[]) =>
      byDelivery
        .filter((row) => statuses.includes(row.status))
        .reduce((sum, row) => sum + row._count._all, 0);

    return {
      enabled: campaign?.enabled ?? false,
      body: campaign?.body ?? DEFAULT_SMS_CAMPAIGN_BODY,
      dailyCap: campaign?.dailyCap ?? SMS_CAMPAIGN_DAILY_CAP,
      from: SMS_CAMPAIGN_FROM_E164,
      sentLast24h,
      waiting: leads.length,
      totals: {
        sent: statusCount('SENT') + statusCount('SENDING'),
        delivered: deliveryCount(MessageStatus.DELIVERED),
        undelivered: deliveryCount(MessageStatus.UNDELIVERED, MessageStatus.FAILED),
        failed: statusCount('FAILED'),
        optedOut: statusCount('OPTED_OUT'),
      },
      lastError: campaign?.lastError ?? null,
      lastSendAt: campaign?.lastSendAt?.toISOString() ?? null,
      recent: recent.map((send) => ({
        id: send.id,
        to: send.toE164,
        schoolName: send.schoolName,
        status: send.status as SmsCampaignSendStatus,
        delivery: send.smsMessage?.status ?? null,
        error:
          send.error ??
          (send.smsMessage?.errorCode
            ? `${send.smsMessage.errorCode}: ${send.smsMessage.errorMessage ?? 'not delivered'}`
            : null),
        sentAt: send.createdAt.toISOString(),
      })),
    };
  }

  async update(
    actor: { userId: string; ipAddress?: string; userAgent?: string },
    input: SmsCampaignUpdateInput,
  ): Promise<SmsCampaignDto> {
    const { userId } = actor;
    if (input.enabled) await this.fromNumber();
    const existing = await this.prisma.smsCampaign.findUnique({ where: { userId } });
    const starting = input.enabled === true && !existing?.enabled;
    const now = new Date();
    await this.prisma.smsCampaign.upsert({
      where: { userId },
      create: {
        userId,
        enabled: input.enabled ?? false,
        body: input.body ?? DEFAULT_SMS_CAMPAIGN_BODY,
        startedAt: input.enabled ? now : null,
      },
      update: {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(starting ? { startedAt: now, lastError: null } : {}),
      },
    });
    await this.audit.log({
      userId,
      action: 'sms_campaign.updated',
      entityType: 'SmsCampaign',
      entityId: userId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      metadata: {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.body !== undefined ? { bodyChanged: true } : {}),
      },
    });
    return this.get(userId, now);
  }

  /** Sends the campaign text to the user's own phone. Not counted, and never blocks a lead. */
  async sendTest(
    actor: { userId: string; ipAddress?: string; userAgent?: string },
    to: string,
  ): Promise<SmsCampaignTestResultDto> {
    const from = await this.fromNumber();
    const campaign = await this.prisma.smsCampaign.findUnique({ where: { userId: actor.userId } });
    const body = renderCampaignText(campaign?.body ?? DEFAULT_SMS_CAMPAIGN_BODY, TEST_SCHOOL_NAME);
    const result = await this.deliver(from, to, body);
    if (!result.ok) {
      throw new BadRequestException(`Twilio did not take the test text: ${result.message}`);
    }
    await this.audit.log({
      userId: actor.userId,
      action: 'sms_campaign.test_sent',
      entityType: 'SmsMessage',
      entityId: result.smsMessageId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent,
      metadata: { to },
    });
    return { to, body };
  }

  async sweep(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const campaigns = await this.prisma.smsCampaign.findMany({ where: { enabled: true } });
      for (const campaign of campaigns) await this.tick(campaign, now);
    } catch (err) {
      this.logger.error(`SMS campaign sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async tick(
    campaign: Awaited<ReturnType<PrismaService['smsCampaign']['findMany']>>[number],
    now: Date,
  ): Promise<void> {
    const gapStart = new Date(now.getTime() - SEND_GAP_MS);
    if (campaign.lastSendAt && campaign.lastSendAt > gapStart) return;
    if (await this.pauseIfBlocked(campaign.userId, campaign.startedAt)) return;
    if (
      (await this.sentSince(campaign.userId, new Date(now.getTime() - DAY_MS))) >= campaign.dailyCap
    ) {
      return;
    }
    const lead = (await this.leads(campaign.userId, now)).find((l) =>
      inSendingHours(now, l.timeZone),
    );
    if (!lead) return;

    let from: PhoneNumber;
    try {
      from = await this.fromNumber();
    } catch (err) {
      await this.noteError(campaign.userId, (err as Error).message);
      return;
    }

    const claimed = await this.prisma.smsCampaign.updateMany({
      where: {
        userId: campaign.userId,
        enabled: true,
        OR: [{ lastSendAt: null }, { lastSendAt: { lte: gapStart } }],
      },
      data: { lastSendAt: now },
    });
    if (claimed.count === 0) return;

    await this.sendTo(campaign.userId, campaign.body, from, lead);
  }

  private async sendTo(
    userId: string,
    template: string,
    from: PhoneNumber,
    lead: CampaignLead,
  ): Promise<void> {
    // The row goes in before Twilio is asked, so a crash mid-send can never
    // lead to a second text for the same number.
    let sendId: string;
    try {
      const send = await this.prisma.smsCampaignSend.create({
        data: {
          userId,
          toE164: lead.toE164,
          pushLogId: lead.pushLogId,
          schoolName: lead.schoolName,
          status: 'SENDING',
        },
      });
      sendId = send.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      throw err;
    }

    const result = await this.deliver(
      from,
      lead.toE164,
      renderCampaignText(template, lead.schoolName),
    );
    if (result.ok) {
      await this.prisma.smsCampaignSend.update({
        where: { id: sendId },
        data: { status: 'SENT', smsMessageId: result.smsMessageId },
      });
      await this.prisma.smsCampaign.updateMany({
        where: { userId, lastError: { not: null } },
        data: { lastError: null },
      });
      this.logger.log(`SMS campaign text sent for push ${lead.pushLogId}`);
      return;
    }

    if (result.code !== null && OPTED_OUT_CODES.has(result.code)) {
      await this.prisma.smsCampaignSend.update({
        where: { id: sendId },
        data: { status: 'OPTED_OUT', error: result.message },
      });
      return;
    }
    if (result.code === null || RECIPIENT_CODES.has(result.code)) {
      // No Twilio code means the request died on the way (timeout, network):
      // the text may have gone out, so the number is not tried again.
      await this.prisma.smsCampaignSend.update({
        where: { id: sendId },
        data: { status: 'FAILED', error: result.message },
      });
      return;
    }
    // Twilio refused it for a reason that isn't this number's: nothing was
    // sent, so the lead stays in line and the error shows on the page.
    await this.prisma.smsCampaignSend.delete({ where: { id: sendId } });
    await this.noteError(userId, `Twilio error ${result.code}: ${result.message}`);
  }

  /** Records the text in the line's inbox and hands it to Twilio. */
  private async deliver(from: PhoneNumber, to: string, body: string): Promise<Delivery> {
    const pending = await this.prisma.smsMessage.create({
      data: {
        phoneNumberId: from.id,
        direction: MessageDirection.OUTBOUND,
        fromE164: from.phoneNumberE164,
        toE164: to,
        body,
        status: MessageStatus.QUEUED,
      },
    });
    let sid: string;
    try {
      const callback = new URL(this.twilio.messagingStatusCallbackUrl);
      callback.searchParams.set('messageId', pending.id);
      const sent = await this.twilio.client.api.v2010
        .accounts(this.twilio.accountSid)
        .messages.create({
          from: from.phoneNumberE164,
          to,
          body,
          statusCallback: callback.toString(),
        });
      sid = sent.sid;
    } catch (err) {
      // Nothing reached the phone, so the inbox shouldn't show it.
      await this.prisma.smsMessage.delete({ where: { id: pending.id } }).catch(() => undefined);
      const code = (err as { code?: unknown }).code;
      return {
        ok: false,
        code: typeof code === 'number' ? code : null,
        message: ((err as Error).message || 'Twilio send failed').slice(0, 500),
      };
    }

    // A status callback can beat this update; don't undo a final status.
    const current = await this.prisma.smsMessage.findUnique({ where: { id: pending.id } });
    const final =
      current?.status === MessageStatus.DELIVERED ||
      current?.status === MessageStatus.UNDELIVERED ||
      current?.status === MessageStatus.FAILED;
    const updated = await this.prisma.smsMessage.update({
      where: { id: pending.id },
      data: final
        ? { twilioMessageSid: sid }
        : { twilioMessageSid: sid, status: MessageStatus.SENT },
    });
    this.realtime.smsSent({ numberId: from.id, message: mapMessage(updated) });
    return { ok: true, smsMessageId: updated.id };
  }

  /** The leads still due a text, newest call first (any hour of the day). */
  private leads(userId: string, now: Date): Promise<CampaignLead[]> {
    const settledBefore = new Date(now.getTime() - SETTLE_MS);
    return this.prisma.$queryRaw<CampaignLead[]>`
      SELECT * FROM (
        SELECT DISTINCT ON (l.destination_e164)
          l.id AS "pushLogId",
          l.destination_e164 AS "toE164",
          l.school_name AS "schoolName",
          l.time_zone AS "timeZone",
          l.call_ended_at AS "callEndedAt"
        FROM sheets_push_logs l
        JOIN google_sheets_connections c ON c.id = l.connection_id
        WHERE c.user_id = ${userId}
          AND l.destination_e164 LIKE '+1%'
          AND NOT EXISTS (
            SELECT 1 FROM sms_campaign_sends s
            WHERE s.user_id = ${userId} AND s.to_e164 = l.destination_e164
          )
          AND NOT EXISTS (
            SELECT 1 FROM sheets_push_logs x
            WHERE x.connection_id = l.connection_id
              AND x.destination_e164 = l.destination_e164
              AND (x.tags @> ${OUT_OF_SERVICE_TAG}::jsonb OR x.tags @> ${BOOKED_TAG}::jsonb)
          )
          AND NOT EXISTS (
            SELECT 1 FROM sms_messages m
            WHERE m.from_e164 = l.destination_e164 OR m.to_e164 = l.destination_e164
          )
        ORDER BY l.destination_e164, l.call_ended_at DESC
      ) leads
      WHERE leads."callEndedAt" <= ${settledBefore}
      ORDER BY leads."callEndedAt" DESC
    `;
  }

  /** Texts Twilio took (or is being asked to take) since a moment. */
  private sentSince(userId: string, since: Date): Promise<number> {
    return this.prisma.smsCampaignSend.count({
      where: { userId, status: { in: ['SENT', 'SENDING'] }, createdAt: { gte: since } },
    });
  }

  /**
   * Pauses the campaign once carriers block BLOCK_LIMIT of the latest
   * BLOCK_WINDOW delivery results since it was started; more texts would
   * only hurt the line.
   */
  private async pauseIfBlocked(userId: string, startedAt: Date | null): Promise<boolean> {
    const results = await this.prisma.smsMessage.findMany({
      where: {
        campaignSend: { is: { userId } },
        status: {
          in: [MessageStatus.DELIVERED, MessageStatus.UNDELIVERED, MessageStatus.FAILED],
        },
        ...(startedAt ? { createdAt: { gte: startedAt } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: BLOCK_WINDOW,
      select: { errorCode: true },
    });
    const blocked = results.filter((m) => m.errorCode && CARRIER_BLOCK_CODES.has(m.errorCode));
    if (blocked.length < BLOCK_LIMIT) return false;
    const codes = [...new Set(blocked.map((m) => m.errorCode))].join(', ');
    await this.prisma.smsCampaign.update({
      where: { userId },
      data: {
        enabled: false,
        lastError: `Paused itself: carriers blocked ${blocked.length} of the last ${results.length} texts (error ${codes}). Check the Twilio console before starting again.`,
      },
    });
    this.logger.warn(`SMS campaign for user ${userId} paused: carriers blocked ${codes}`);
    return true;
  }

  private async noteError(userId: string, message: string): Promise<void> {
    this.logger.warn(`SMS campaign send did not go out: ${message}`);
    await this.prisma.smsCampaign.update({
      where: { userId },
      data: { lastError: message.slice(0, 500) },
    });
  }

  private async fromNumber(): Promise<PhoneNumber> {
    const number = await this.prisma.phoneNumber.findUnique({
      where: { phoneNumberE164: SMS_CAMPAIGN_FROM_E164 },
    });
    if (!number || !number.active || !number.capabilitiesSms) {
      throw new BadRequestException(
        `${SMS_CAMPAIGN_FROM_E164} is missing from Numbers or can't send texts.`,
      );
    }
    return number;
  }
}
