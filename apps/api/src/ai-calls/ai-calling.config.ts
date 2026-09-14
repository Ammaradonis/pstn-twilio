import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ConsultSchedule } from './consult-slots';

function intOr(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

// Settings for the Vapi consultation-booking agent, read from the environment.
@Injectable()
export class AiCallingConfig {
  constructor(private readonly config: ConfigService) {}

  private get(key: string): string | undefined {
    const value = this.config.get<string>(key)?.trim();
    return value ? value : undefined;
  }

  get vapiPrivateKey(): string | undefined {
    return this.get('VAPI_PRIVATE_KEY');
  }

  // The Vapi phone number (the 667 line) outbound calls are placed from.
  get vapiPhoneNumberId(): string | undefined {
    return this.get('VAPI_PHONE_NUMBER_ID');
  }

  get vapiAssistantId(): string | undefined {
    return this.get('VAPI_ASSISTANT_ID');
  }

  get vapiWebhookSecret(): string | undefined {
    return this.get('VAPI_WEBHOOK_SECRET');
  }

  get callerNumber(): string | null {
    return this.get('AI_CALLER_NUMBER') ?? null;
  }

  get agentName(): string {
    return this.get('AI_AGENT_NAME') ?? 'Sarah';
  }

  get businessName(): string | undefined {
    return this.get('AI_BUSINESS_NAME');
  }

  get hostName(): string | undefined {
    return this.get('AI_HOST_NAME');
  }

  // Optional demo line prospects can call to hear the agent answer as a school.
  get demoNumber(): string | undefined {
    return this.get('AI_DEMO_NUMBER');
  }

  get defaultStateCode(): string {
    return (this.get('AI_DEFAULT_STATE') ?? 'AL').toUpperCase();
  }

  // Prospect-local hours outbound calls may be placed in: 8 AM to 9 PM, the
  // federal telemarketing calling window.
  get callWindow(): { startHour: number; endHour: number } {
    return {
      startHour: intOr(this.get('AI_CALL_WINDOW_START_HOUR'), 8),
      endHour: intOr(this.get('AI_CALL_WINDOW_END_HOUR'), 21),
    };
  }

  get schedule(): ConsultSchedule {
    const weekdays = (this.get('CONSULT_WEEKDAYS') ?? '1,2,3,4,5')
      .split(',')
      .map((d) => Number.parseInt(d, 10))
      .filter((d) => d >= 0 && d <= 6);
    return {
      durationMinutes: intOr(this.get('CONSULT_MINUTES'), 20),
      stepMinutes: intOr(this.get('CONSULT_STEP_MINUTES'), 30),
      dayStartHour: intOr(this.get('CONSULT_DAY_START_HOUR'), 9),
      dayEndHour: intOr(this.get('CONSULT_DAY_END_HOUR'), 18),
      weekdays: weekdays.length > 0 ? weekdays : [1, 2, 3, 4, 5],
      minLeadMinutes: intOr(this.get('CONSULT_MIN_LEAD_MINUTES'), 120),
      horizonDays: intOr(this.get('CONSULT_HORIZON_DAYS'), 10),
      bufferMinutes: intOr(this.get('CONSULT_BUFFER_MINUTES'), 10),
    };
  }

  get googleClientId(): string | undefined {
    return this.get('GOOGLE_CLIENT_ID');
  }

  get googleClientSecret(): string | undefined {
    return this.get('GOOGLE_CLIENT_SECRET');
  }

  get publicApiBaseUrl(): string {
    return (
      this.get('TWILIO_WEBHOOK_BASE_URL') ??
      this.get('PUBLIC_BASE_URL') ??
      'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  get googleRedirectUri(): string {
    return (
      this.get('GOOGLE_OAUTH_REDIRECT_URI') ??
      `${this.publicApiBaseUrl}/webhooks/google-calendar/oauth/callback`
    );
  }

  get vapiWebhookUrl(): string {
    return `${this.publicApiBaseUrl}/webhooks/vapi`;
  }

  get webAppUrl(): string {
    return (this.get('WEB_APP_URL') ?? 'https://webfitalchemist.online').replace(/\/$/, '');
  }

  get tokenEncryptionKey(): string | undefined {
    return this.get('TOKEN_ENCRYPTION_KEY');
  }

  get stateSigningSecret(): string | undefined {
    return this.get('JWT_SECRET');
  }

  get ownerEmail(): string | undefined {
    return this.get('OWNER_EMAIL');
  }

  // Server-side settings still missing before calls can be placed.
  missingServerSettings(): string[] {
    const missing: string[] = [];
    if (!this.vapiPrivateKey) missing.push('Set VAPI_PRIVATE_KEY on the API.');
    if (!this.vapiPhoneNumberId) missing.push('Set VAPI_PHONE_NUMBER_ID on the API.');
    if (!this.vapiAssistantId) missing.push('Run the Vapi sync script and set VAPI_ASSISTANT_ID.');
    if (!this.vapiWebhookSecret) missing.push('Set VAPI_WEBHOOK_SECRET on the API.');
    if (!this.businessName) missing.push('Set AI_BUSINESS_NAME (who the agent calls for).');
    if (!this.hostName) missing.push('Set AI_HOST_NAME (who runs the consultation).');
    if (!this.googleClientId || !this.googleClientSecret) {
      missing.push('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for calendar access.');
    }
    if (!this.tokenEncryptionKey) missing.push('Set TOKEN_ENCRYPTION_KEY on the API.');
    return missing;
  }
}
