import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AiInboundMode, AiInboundStatusDto } from '@pstn-twilio/shared';

import { AuditService } from '../audit/audit.service';
import { TwilioService } from '../twilio/twilio.service';

import { AiCallingConfig } from './ai-calling.config';

// Where Vapi receives calls to numbers imported from Twilio.
export const VAPI_TWILIO_INBOUND_URL = 'https://api.vapi.ai/twilio/inbound_call';
// Query on the inbound webhook that hands calls the browser doesn't answer to
// the agent (see VoiceWebhookService.handleVoicemail).
export const AGENT_FALLBACK_QUERY = 'fallback=agent';

interface Actor {
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

// Switches incoming calls on the AI caller line (the 667 number) between the
// browser, the browser with the agent picking up unanswered calls, and a busy
// signal. Twilio's Voice URL is the source of truth: outbound AI calls never use
// it, so blocking incoming calls doesn't affect them.
@Injectable()
export class InboundCallsService {
  constructor(
    private readonly twilio: TwilioService,
    private readonly settings: AiCallingConfig,
    private readonly audit: AuditService,
  ) {}

  get rejectUrl(): string {
    return `${this.settings.publicApiBaseUrl}/webhooks/twilio/voice/reject`;
  }

  private get browserUrl(): string {
    return `${this.settings.publicApiBaseUrl}/webhooks/twilio/voice/inbound`;
  }

  private voiceUrlFor(mode: AiInboundMode): string {
    if (mode === 'blocked') return this.rejectUrl;
    if (mode === 'browser-then-agent') return `${this.browserUrl}?${AGENT_FALLBACK_QUERY}`;
    return this.browserUrl;
  }

  async status(): Promise<AiInboundStatusDto> {
    const number = await this.findNumber();
    return { phoneNumber: number.phoneNumber, mode: this.modeFor(number.voiceUrl) };
  }

  async setMode(actor: Actor, mode: AiInboundMode): Promise<AiInboundStatusDto> {
    if (mode !== 'blocked' && mode !== 'browser' && mode !== 'browser-then-agent') {
      throw new BadRequestException(`Unknown incoming call mode: ${String(mode)}`);
    }
    const number = await this.findNumber();
    const previous = this.modeFor(number.voiceUrl);
    try {
      const updated = await this.twilio.client.api.v2010
        .accounts(this.twilio.accountSid)
        .incomingPhoneNumbers(number.sid)
        .update({
          voiceUrl: this.voiceUrlFor(mode),
          voiceMethod: 'POST',
          voiceApplicationSid: '',
          voiceFallbackUrl: this.rejectUrl,
          voiceFallbackMethod: 'POST',
        });
      await this.audit.log({
        userId: actor.userId,
        action:
          mode === 'blocked'
            ? 'ai_inbound.blocked'
            : mode === 'browser-then-agent'
              ? 'ai_inbound.browser_then_agent_enabled'
              : 'ai_inbound.browser_enabled',
        entityType: 'PhoneNumber',
        entityId: number.sid,
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent,
        metadata: { phoneNumber: number.phoneNumber, previous, previousVoiceUrl: number.voiceUrl },
      });
      return { phoneNumber: updated.phoneNumber, mode: this.modeFor(updated.voiceUrl) };
    } catch (err) {
      throw new BadGatewayException(
        `Twilio couldn't update incoming calls: ${err instanceof Error ? err.message : 'unknown error'}`,
      );
    }
  }

  private modeFor(voiceUrl: string | null | undefined): AiInboundStatusDto['mode'] {
    if (voiceUrl === this.rejectUrl) return 'blocked';
    if (voiceUrl === this.browserUrl) return 'browser';
    if (voiceUrl === this.voiceUrlFor('browser-then-agent')) return 'browser-then-agent';
    if (voiceUrl === VAPI_TWILIO_INBOUND_URL) return 'agent';
    return 'other';
  }

  private async findNumber(): Promise<{ sid: string; phoneNumber: string; voiceUrl: string }> {
    const callerNumber = this.settings.callerNumber;
    if (!callerNumber) throw new NotFoundException('AI_CALLER_NUMBER is not set.');
    const [number] = await this.twilio.client.api.v2010
      .accounts(this.twilio.accountSid)
      .incomingPhoneNumbers.list({ phoneNumber: callerNumber, limit: 1 });
    if (!number) throw new NotFoundException(`${callerNumber} is not on the Twilio account.`);
    return { sid: number.sid, phoneNumber: number.phoneNumber, voiceUrl: number.voiceUrl };
  }
}
