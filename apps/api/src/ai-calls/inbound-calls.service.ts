import { BadGatewayException, Injectable, NotFoundException } from '@nestjs/common';
import type { AiInboundMode, AiInboundStatusDto } from '@pstn-twilio/shared';

import { AuditService } from '../audit/audit.service';
import { TwilioService } from '../twilio/twilio.service';

import { AiCallingConfig } from './ai-calling.config';

// Where Vapi receives calls to numbers imported from Twilio.
export const VAPI_TWILIO_INBOUND_URL = 'https://api.vapi.ai/twilio/inbound_call';

interface Actor {
  userId: string;
  ipAddress?: string;
  userAgent?: string;
}

// Switches incoming calls on the AI caller line (the 667 number) between the
// agent and a busy signal. Twilio's Voice URL is the source of truth: outbound
// AI calls never use it, so blocking incoming calls doesn't affect them.
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

  async status(): Promise<AiInboundStatusDto> {
    const number = await this.findNumber();
    return { phoneNumber: number.phoneNumber, mode: this.modeFor(number.voiceUrl) };
  }

  async setMode(actor: Actor, mode: AiInboundMode): Promise<AiInboundStatusDto> {
    const number = await this.findNumber();
    const previous = this.modeFor(number.voiceUrl);
    try {
      const updated = await this.twilio.client.api.v2010
        .accounts(this.twilio.accountSid)
        .incomingPhoneNumbers(number.sid)
        .update({
          voiceUrl: mode === 'blocked' ? this.rejectUrl : VAPI_TWILIO_INBOUND_URL,
          voiceMethod: 'POST',
        });
      await this.audit.log({
        userId: actor.userId,
        action: mode === 'blocked' ? 'ai_inbound.blocked' : 'ai_inbound.agent_enabled',
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
