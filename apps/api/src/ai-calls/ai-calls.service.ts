import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AiCall, AiCallDirection, AiCallStatus, Prisma, UserRole } from '@prisma/client';
import {
  findUsState,
  normalizeDialablePhoneNumber,
  timeZoneLabel,
  type AiCallDto,
  type AiCallOutcome,
  type AiCallingConfigDto,
  type StartAiCallInput,
  type UsState,
} from '@pstn-twilio/shared';

import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

import { AiCallingConfig } from './ai-calling.config';
import {
  TOOL_BOOK_CONSULTATION,
  TOOL_CHECK_AVAILABILITY,
  type AssistantVariables,
} from './consult-booker.assistant';
import { freeConsultSlots, isBookableSlot, pickSlotOptions, type PartOfDay } from './consult-slots';
import { CalendarUnavailableError, GoogleCalendarService } from './google-calendar.service';
import { VapiClient, VapiRequestError } from './vapi.client';
import { localNowText, spokenDateTime, zonedParts } from './zoned-time';

interface Actor {
  userId: string;
  role: UserRole;
  ipAddress?: string;
  userAgent?: string;
}

// The subset of Vapi's server message payloads this integration reads.
export interface VapiServerMessage {
  type?: string;
  status?: string;
  endedReason?: string;
  startedAt?: string;
  endedAt?: string;
  cost?: number;
  call?: {
    id?: string;
    customer?: { number?: string };
    assistantOverrides?: { metadata?: { aiCallId?: string } };
  };
  customer?: { number?: string };
  analysis?: { summary?: string; structuredData?: Record<string, unknown> };
  artifact?: {
    transcript?: string;
    recordingUrl?: string;
    recording?: { mono?: { combinedUrl?: string } };
  };
  recordingUrl?: string;
  transcript?: string;
  summary?: string;
  toolCallList?: VapiToolCall[];
  toolWithToolCallList?: { name?: string; toolCall?: VapiToolCall }[];
}

interface VapiToolCall {
  id: string;
  name?: string;
  parameters?: Record<string, unknown>;
  arguments?: Record<string, unknown> | string;
  function?: { name?: string; arguments?: Record<string, unknown> | string };
}

const STATUS_MAP: Record<string, AiCallStatus> = {
  scheduled: AiCallStatus.QUEUED,
  queued: AiCallStatus.QUEUED,
  ringing: AiCallStatus.RINGING,
  'in-progress': AiCallStatus.IN_PROGRESS,
  forwarding: AiCallStatus.FORWARDING,
  ended: AiCallStatus.ENDED,
};

const NO_ANSWER_REASONS = [
  'customer-did-not-answer',
  'customer-busy',
  'customer-did-not-give-microphone-permission',
];
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

@Injectable()
export class AiCallsService {
  private readonly logger = new Logger(AiCallsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AiCallingConfig,
    private readonly calendar: GoogleCalendarService,
    private readonly vapi: VapiClient,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  async config(userId: string): Promise<AiCallingConfigDto> {
    const calendar = await this.calendar.status(userId);
    const missing = this.settings.missingServerSettings();
    if (!calendar.connected) missing.push('Connect your Google Calendar in Settings.');
    return {
      ready: missing.length === 0,
      missing,
      callerNumber: this.settings.callerNumber,
      defaultStateCode: this.settings.defaultStateCode,
      consultMinutes: this.settings.schedule.durationMinutes,
      calendar,
    };
  }

  async startCall(actor: Actor, input: StartAiCallInput, now = new Date()): Promise<AiCallDto> {
    const state = findUsState(input.stateCode);
    if (!state) throw new BadRequestException('Unknown US state.');
    const timeZone = input.timeZone ?? state.timeZones[0]!;
    if (!state.timeZones.includes(timeZone)) {
      throw new BadRequestException(`${timeZone} is not a time zone used in ${state.name}.`);
    }
    const destination = normalizeDialablePhoneNumber(input.destinationNumber);
    if (!destination || !destination.startsWith('+1')) {
      throw new BadRequestException('AI calls can only dial U.S. numbers.');
    }

    const blocked = await this.prisma.doNotCallNumber.findUnique({ where: { e164: destination } });
    if (blocked) {
      throw new ConflictException('This number asked not to be called again.');
    }

    const local = zonedParts(now, timeZone);
    const { startHour, endHour } = this.settings.callWindow;
    if (local.hour < startHour || local.hour >= endHour) {
      throw new ConflictException(
        `It's ${spokenDateTime(now, timeZone).split(' at ')[1]} in ${state.name}. The agent only calls between ${hourLabel(startHour)} and ${hourLabel(endHour)} local time.`,
      );
    }

    const setup = await this.config(actor.userId);
    if (!setup.ready) {
      throw new ConflictException(`AI calling isn't set up yet: ${setup.missing.join(' ')}`);
    }

    const aiCall = await this.prisma.aiCall.create({
      data: {
        userId: actor.userId,
        direction: AiCallDirection.OUTBOUND,
        customerE164: destination,
        stateCode: state.code,
        timeZone,
      },
    });

    try {
      const call = await this.vapi.createCall({
        assistantId: this.settings.vapiAssistantId,
        phoneNumberId: this.settings.vapiPhoneNumberId,
        customer: { number: destination },
        assistantOverrides: {
          variableValues: this.variableValues(state, timeZone, 'outbound', now),
          metadata: { aiCallId: aiCall.id },
        },
      });
      const updated = await this.prisma.aiCall.update({
        where: { id: aiCall.id },
        data: { vapiCallId: call.id, status: STATUS_MAP[call.status ?? ''] ?? AiCallStatus.QUEUED },
      });
      await this.audit.log({
        userId: actor.userId,
        action: 'ai_call.started',
        entityType: 'AiCall',
        entityId: aiCall.id,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        metadata: { destination, stateCode: state.code, timeZone, vapiCallId: call.id },
      });
      return this.publish(updated);
    } catch (err) {
      const message = err instanceof VapiRequestError ? err.message : 'Vapi request failed';
      await this.prisma.aiCall.update({
        where: { id: aiCall.id },
        data: {
          status: AiCallStatus.FAILED,
          outcome: 'failed',
          endedReason: message.slice(0, 500),
        },
      });
      this.logger.warn(`Vapi call creation failed: ${message}`);
      throw new BadGatewayException(`Vapi couldn't start the call: ${message}`);
    }
  }

  async list(userId: string, limit = 20): Promise<AiCallDto[]> {
    const rows = await this.prisma.aiCall.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
    return rows.map(toAiCallDto);
  }

  async get(userId: string, id: string): Promise<AiCallDto> {
    const row = await this.prisma.aiCall.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException('AI call not found');
    // If a webhook was missed, catch up from Vapi.
    if (row.vapiCallId && row.status !== AiCallStatus.ENDED && row.status !== AiCallStatus.FAILED) {
      try {
        const call = await this.vapi.getCall(row.vapiCallId);
        if (call.status === 'ended') {
          return toAiCallDto(
            await this.applyEndOfCall(row, {
              endedReason: call.endedReason,
              startedAt: call.startedAt,
              endedAt: call.endedAt,
              cost: call.cost,
              analysis: call.analysis,
              artifact: call.artifact,
            }),
          );
        }
      } catch (err) {
        this.logger.warn(`Vapi call refresh failed: ${(err as Error).message}`);
      }
    }
    return toAiCallDto(row);
  }

  // Handles a Vapi server message and returns the response body Vapi expects.
  async handleWebhook(message: VapiServerMessage): Promise<Record<string, unknown>> {
    switch (message.type) {
      case 'tool-calls':
        return { results: await this.handleToolCalls(message) };
      case 'assistant-request':
        return this.handleAssistantRequest(message);
      case 'status-update': {
        const row = await this.findCallForMessage(message);
        const status = STATUS_MAP[message.status ?? ''];
        if (row && status && row.status !== AiCallStatus.ENDED) {
          await this.publish(
            await this.prisma.aiCall.update({
              where: { id: row.id },
              data: {
                status,
                ...(status === AiCallStatus.IN_PROGRESS && !row.startedAt
                  ? { startedAt: new Date() }
                  : {}),
              },
            }),
          );
        }
        return {};
      }
      case 'end-of-call-report': {
        const row = await this.findCallForMessage(message);
        if (row) await this.applyEndOfCall(row, message);
        return {};
      }
      default:
        return {};
    }
  }

  variableValues(
    state: UsState,
    timeZone: string,
    callContext: 'outbound' | 'callback',
    now = new Date(),
  ): AssistantVariables {
    return {
      agentName: this.settings.agentName,
      businessName: this.settings.businessName ?? '',
      hostName: this.settings.hostName ?? '',
      consultMinutes: String(this.settings.schedule.durationMinutes),
      stateName: state.name,
      timeZoneLabel: timeZoneLabel(timeZone),
      prospectLocalNow: localNowText(now, timeZone),
      recordingNotice: state.allPartyRecordingConsent ? 'Mention that the call is recorded.' : '',
      demoLine: this.settings.demoNumber ? spokenPhone(this.settings.demoNumber) : '',
      callContext,
    };
  }

  private async handleAssistantRequest(
    message: VapiServerMessage,
  ): Promise<Record<string, unknown>> {
    const assistantId = this.settings.vapiAssistantId;
    // Without these the agent would introduce itself for nobody.
    if (!assistantId || !this.settings.businessName || !this.settings.hostName) {
      return { error: "Sorry, we can't take your call right now. Please try again later." };
    }

    const customer = normalizeDialablePhoneNumber(
      message.call?.customer?.number ?? message.customer?.number ?? '',
    );
    const previous = customer
      ? await this.prisma.aiCall.findFirst({
          where: { customerE164: customer, direction: AiCallDirection.OUTBOUND },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    const state =
      findUsState(previous?.stateCode ?? this.settings.defaultStateCode) ?? findUsState('AL')!;
    const timeZone = previous?.timeZone ?? state.timeZones[0]!;
    const userId = previous?.userId ?? (await this.ownerUserId());

    if (message.call?.id) {
      await this.prisma.aiCall.upsert({
        where: { vapiCallId: message.call.id },
        create: {
          vapiCallId: message.call.id,
          userId,
          direction: AiCallDirection.INBOUND,
          customerE164: customer ?? message.call?.customer?.number ?? 'unknown',
          stateCode: state.code,
          timeZone,
          status: AiCallStatus.RINGING,
          schoolName: previous?.schoolName ?? null,
          contactName: previous?.contactName ?? null,
        },
        update: {},
      });
    }
    return {
      assistantId,
      assistantOverrides: { variableValues: this.variableValues(state, timeZone, 'callback') },
    };
  }

  private async handleToolCalls(message: VapiServerMessage) {
    const row = await this.findCallForMessage(message);
    const calls: VapiToolCall[] =
      message.toolCallList ??
      (message.toolWithToolCallList ?? []).flatMap((t) =>
        t.toolCall ? [{ ...t.toolCall, name: t.toolCall.name ?? t.name }] : [],
      );

    const results = [];
    for (const call of calls) {
      const name = call.name ?? call.function?.name ?? '';
      const args = toolArguments(call);
      let result: unknown;
      try {
        if (!row) {
          result = {
            error: 'unknown_call',
            note: 'Say the calendar is unavailable and offer an email follow-up.',
          };
        } else if (name === TOOL_CHECK_AVAILABILITY) {
          result = await this.checkAvailability(row, args);
        } else if (name === TOOL_BOOK_CONSULTATION) {
          result = await this.bookConsultation(row, args);
        } else {
          result = { error: `unknown_tool:${name}` };
        }
      } catch (err) {
        this.logger.warn(`Tool ${name} failed: ${(err as Error).message}`);
        result = {
          error: 'calendar_unavailable',
          note: `The calendar can't be reached right now. Apologize, say ${this.settings.hostName ?? 'the host'} will email a few times, and confirm their email.`,
        };
      }
      results.push({ name, toolCallId: call.id, result: JSON.stringify(result) });
    }
    return results;
  }

  async checkAvailability(row: AiCall, args: Record<string, unknown>, now = new Date()) {
    const userId = row.userId ?? (await this.ownerUserId());
    if (!userId) throw new CalendarUnavailableError('No calendar owner');
    const schedule = this.settings.schedule;
    const busy = await this.calendar.busyIntervals(
      userId,
      now,
      new Date(now.getTime() + (schedule.horizonDays + 1) * 86_400_000),
    );
    const preferredDate = typeof args.preferredDate === 'string' ? args.preferredDate : undefined;
    const partOfDay = ['morning', 'afternoon', 'any'].includes(String(args.partOfDay))
      ? (args.partOfDay as PartOfDay)
      : 'any';

    let slots = freeConsultSlots(now, row.timeZone, schedule, busy, {
      date: preferredDate,
      partOfDay,
    });
    let note = 'Offer two of these options and ask which works.';
    if (slots.length === 0) {
      slots = freeConsultSlots(now, row.timeZone, schedule, busy);
      note =
        slots.length === 0
          ? 'No open times in the next two weeks. Offer to have the host email them times, and collect their email.'
          : 'Nothing is open for what they asked. Say so briefly and offer two of these instead.';
    }
    return {
      timeZone: timeZoneLabel(row.timeZone),
      options: pickSlotOptions(slots, row.timeZone).map((slot) => ({
        startIso: slot.start.toISOString(),
        spoken: slot.spoken,
      })),
      note,
    };
  }

  async bookConsultation(row: AiCall, args: Record<string, unknown>, now = new Date()) {
    if (row.consultEventId && row.consultStartAt) {
      return {
        booked: true,
        alreadyBooked: true,
        spoken: `${spokenDateTime(row.consultStartAt, row.timeZone)} ${timeZoneLabel(row.timeZone)}`,
      };
    }
    const start = new Date(String(args.startIso ?? ''));
    const email = String(args.email ?? '')
      .trim()
      .toLowerCase();
    const contactName = String(args.contactName ?? '').trim();
    const schoolName = String(args.schoolName ?? '').trim();
    if (Number.isNaN(start.getTime())) {
      return {
        booked: false,
        reason: 'invalid_time',
        note: 'Check availability again and use an offered startIso.',
      };
    }
    if (!EMAIL_PATTERN.test(email)) {
      return {
        booked: false,
        reason: 'invalid_email',
        note: 'Ask for the email again and spell it back.',
      };
    }
    if (!contactName || !schoolName) {
      return {
        booked: false,
        reason: 'missing_details',
        note: 'Ask for their full name and the school name.',
      };
    }

    const userId = row.userId ?? (await this.ownerUserId());
    if (!userId) throw new CalendarUnavailableError('No calendar owner');
    const schedule = this.settings.schedule;
    const busy = await this.calendar.busyIntervals(
      userId,
      now,
      new Date(now.getTime() + (schedule.horizonDays + 1) * 86_400_000),
    );
    if (!isBookableSlot(start, now, row.timeZone, schedule, busy)) {
      const alternatives = pickSlotOptions(
        freeConsultSlots(now, row.timeZone, schedule, busy),
        row.timeZone,
      );
      return {
        booked: false,
        reason: 'slot_taken',
        note: 'That time is no longer open. Apologize and offer two of these.',
        alternatives: alternatives.map((s) => ({
          startIso: s.start.toISOString(),
          spoken: s.spoken,
        })),
      };
    }

    const end = new Date(start.getTime() + schedule.durationMinutes * 60_000);
    const state = findUsState(row.stateCode);
    const role = typeof args.role === 'string' ? args.role : null;
    const notes = typeof args.notes === 'string' ? args.notes : null;
    const event = await this.calendar.createConsultEvent(userId, {
      start,
      end,
      timeZone: row.timeZone,
      summary: `${schoolName} x ${this.settings.businessName ?? 'Consultation'}`,
      description: [
        `Consultation booked by the AI agent.`,
        `Contact: ${contactName}${role ? ` (${role})` : ''}`,
        `School: ${schoolName}`,
        `Phone: ${row.customerE164}`,
        `Email: ${email}`,
        `Location: ${state?.name ?? row.stateCode}, ${timeZoneLabel(row.timeZone)}`,
        notes ? `Notes: ${notes}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      attendeeEmail: email,
    });

    await this.publish(
      await this.prisma.aiCall.update({
        where: { id: row.id },
        data: {
          consultStartAt: start,
          consultEventId: event.eventId,
          consultMeetUrl: event.meetUrl,
          contactName,
          contactEmail: email,
          schoolName,
          outcome: 'booked',
        },
      }),
    );
    await this.audit.log({
      userId,
      action: 'ai_call.consult_booked',
      entityType: 'AiCall',
      entityId: row.id,
      metadata: { start: start.toISOString(), schoolName, eventId: event.eventId },
    });
    return {
      booked: true,
      spoken: `${spokenDateTime(start, row.timeZone)} ${timeZoneLabel(row.timeZone)}`,
      inviteSentTo: email,
      meetLinkIncluded: Boolean(event.meetUrl),
    };
  }

  private async applyEndOfCall(row: AiCall, message: VapiServerMessage): Promise<AiCall> {
    const data = (message.analysis?.structuredData ?? {}) as Record<string, unknown>;
    const endedReason = message.endedReason ?? null;
    const doNotCall = data.doNotCall === true;
    const outcome = deriveOutcome(row, data, endedReason, message.startedAt);
    const text = (value: unknown) =>
      typeof value === 'string' && value.trim() ? value.trim() : null;

    const updated = await this.prisma.aiCall.update({
      where: { id: row.id },
      data: {
        status: outcome === 'failed' ? AiCallStatus.FAILED : AiCallStatus.ENDED,
        outcome,
        endedReason,
        summary: message.analysis?.summary ?? message.summary ?? row.summary,
        structuredData: (message.analysis?.structuredData ?? undefined) as
          | Prisma.InputJsonValue
          | undefined,
        transcript: message.artifact?.transcript ?? message.transcript ?? row.transcript,
        recordingUrl:
          message.artifact?.recordingUrl ??
          message.artifact?.recording?.mono?.combinedUrl ??
          message.recordingUrl ??
          row.recordingUrl,
        schoolName: row.schoolName ?? text(data.schoolName),
        contactName: row.contactName ?? text(data.contactName) ?? text(data.ownerName),
        contactEmail: row.contactEmail ?? text(data.contactEmail),
        callbackTime: text(data.callbackTime),
        costUsd: typeof message.cost === 'number' ? new Prisma.Decimal(message.cost) : undefined,
        startedAt: message.startedAt ? new Date(message.startedAt) : row.startedAt,
        endedAt: message.endedAt ? new Date(message.endedAt) : new Date(),
      },
    });

    if (doNotCall) {
      await this.prisma.doNotCallNumber.upsert({
        where: { e164: row.customerE164 },
        create: {
          e164: row.customerE164,
          source: 'ai_call',
          aiCallId: row.id,
          reason: 'Asked during AI call',
        },
        update: {},
      });
    }
    return this.publishRow(updated);
  }

  private async findCallForMessage(message: VapiServerMessage): Promise<AiCall | null> {
    const vapiCallId = message.call?.id;
    if (vapiCallId) {
      const byVapiId = await this.prisma.aiCall.findUnique({ where: { vapiCallId } });
      if (byVapiId) return byVapiId;
    }
    // The webhook can beat the create-call response that stores the Vapi id.
    const aiCallId = message.call?.assistantOverrides?.metadata?.aiCallId;
    if (!aiCallId) return null;
    const row = await this.prisma.aiCall.findUnique({ where: { id: aiCallId } });
    if (row && vapiCallId && !row.vapiCallId) {
      return this.prisma.aiCall.update({ where: { id: row.id }, data: { vapiCallId } });
    }
    return row;
  }

  private async ownerUserId(): Promise<string | null> {
    const email = this.settings.ownerEmail;
    const owner =
      (email ? await this.prisma.user.findUnique({ where: { email } }) : null) ??
      (await this.prisma.user.findFirst({
        where: { role: UserRole.OWNER },
        orderBy: { createdAt: 'asc' },
      }));
    return owner?.id ?? null;
  }

  private async publish(row: AiCall): Promise<AiCallDto> {
    const dto = toAiCallDto(row);
    this.realtime.aiCallUpdated({ aiCall: dto });
    return dto;
  }

  private async publishRow(row: AiCall): Promise<AiCall> {
    await this.publish(row);
    return row;
  }
}

export function deriveOutcome(
  row: Pick<AiCall, 'consultEventId' | 'outcome'>,
  data: Record<string, unknown>,
  endedReason: string | null,
  startedAt?: string,
): AiCallOutcome {
  if (row.consultEventId) return 'booked';
  if (data.doNotCall === true) return 'do_not_call';
  const reason = endedReason ?? '';
  if (reason === 'voicemail' || data.reachedVoicemail === true) return 'voicemail';
  if (NO_ANSWER_REASONS.includes(reason)) return 'no_answer';
  if (!startedAt && /error|failed|fault/i.test(reason)) return 'failed';
  if (data.callbackRequested === true) return 'callback';
  if (data.interestLevel === 'not_interested') return 'not_interested';
  if (data.reachedDecisionMaker === false && data.contactRole === 'front_desk') return 'gatekeeper';
  return 'other';
}

export function toAiCallDto(row: AiCall): AiCallDto {
  return {
    id: row.id,
    direction: row.direction,
    vapiCallId: row.vapiCallId,
    customerNumber: row.customerE164,
    stateCode: row.stateCode,
    timeZone: row.timeZone,
    status: row.status,
    outcome: (row.outcome as AiCallOutcome | null) ?? null,
    endedReason: row.endedReason,
    summary: row.summary,
    schoolName: row.schoolName,
    contactName: row.contactName,
    contactEmail: row.contactEmail,
    consultStartAt: row.consultStartAt?.toISOString() ?? null,
    consultMeetUrl: row.consultMeetUrl,
    callbackTime: row.callbackTime,
    recordingUrl: row.recordingUrl,
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toolArguments(call: VapiToolCall): Record<string, unknown> {
  const raw = call.parameters ?? call.arguments ?? call.function?.arguments ?? {};
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function hourLabel(hour: number): string {
  const h = hour % 24;
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

// "+18776524532" -> "(877) 652-4532"
function spokenPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return digits.length === 10
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : e164;
}
