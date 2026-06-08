import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import twilio, { type Twilio, validateRequest } from 'twilio';

export interface TwilioRecordingMedia {
  body: Buffer;
  contentType: string;
}

@Injectable()
export class TwilioService {
  private readonly logger = new Logger(TwilioService.name);
  private clientInstance: Twilio | null = null;

  constructor(private readonly config: ConfigService) {}

  get accountSid(): string {
    const sid = this.config.get<string>('TWILIO_ACCOUNT_SID');
    if (!sid) throw new Error('TWILIO_ACCOUNT_SID is required');
    return sid;
  }

  get authToken(): string {
    const token = this.config.get<string>('TWILIO_AUTH_TOKEN');
    if (!token) throw new Error('TWILIO_AUTH_TOKEN is required');
    return token;
  }

  get webhookBaseUrl(): string {
    const url =
      this.config.get<string>('TWILIO_WEBHOOK_BASE_URL') ??
      this.config.get<string>('PUBLIC_BASE_URL');
    if (!url) throw new Error('TWILIO_WEBHOOK_BASE_URL or PUBLIC_BASE_URL is required');
    return url.replace(/\/$/, '');
  }

  get defaultCountry(): string {
    return this.config.get<string>('TWILIO_DEFAULT_COUNTRY') ?? 'US';
  }

  get apiKeySid(): string {
    const v = this.config.get<string>('TWILIO_API_KEY_SID');
    if (!v) throw new Error('TWILIO_API_KEY_SID is required for Voice tokens');
    return v;
  }

  get apiKeySecret(): string {
    const v = this.config.get<string>('TWILIO_API_KEY_SECRET');
    if (!v) throw new Error('TWILIO_API_KEY_SECRET is required for Voice tokens');
    return v;
  }

  get twimlAppSid(): string {
    const v = this.config.get<string>('TWILIO_TWIML_APP_SID');
    if (!v) throw new Error('TWILIO_TWIML_APP_SID is required for Voice tokens');
    return v;
  }

  voiceIdentity(userId: string, numberId?: string | null): string {
    const userPart = userId.replace(/[^a-zA-Z0-9]/g, '');
    if (numberId) {
      const numPart = numberId.replace(/[^a-zA-Z0-9]/g, '');
      return `user_${userPart}_number_${numPart}`;
    }
    return `user_${userPart}`;
  }

  get client(): Twilio {
    if (!this.clientInstance) {
      this.clientInstance = twilio(this.accountSid, this.authToken);
    }
    return this.clientInstance;
  }

  validateSignature(signature: string | undefined, url: string, params: Record<string, unknown>) {
    if (!signature) return false;
    try {
      return validateRequest(this.authToken, signature, url, params);
    } catch {
      return false;
    }
  }

  defaultWebhookUrls() {
    const base = this.webhookBaseUrl;
    return {
      outboundVoiceUrl: `${base}/webhooks/twilio/voice/outbound`,
      outboundVoiceFallbackUrl: `${base}/webhooks/twilio/voice/fallback`,
      voiceUrl: `${base}/webhooks/twilio/voice/inbound`,
      voiceFallbackUrl: `${base}/webhooks/twilio/voice/fallback`,
      statusCallback: `${base}/webhooks/twilio/voice/status`,
      smsUrl: `${base}/webhooks/twilio/messaging/inbound`,
      smsFallbackUrl: `${base}/webhooks/twilio/messaging/inbound`,
    };
  }

  async configureTwimlApplication(): Promise<void> {
    const webhooks = this.defaultWebhookUrls();
    await this.client.applications(this.twimlAppSid).update({
      voiceUrl: webhooks.outboundVoiceUrl,
      voiceMethod: 'POST',
      voiceFallbackUrl: webhooks.outboundVoiceFallbackUrl,
      voiceFallbackMethod: 'POST',
      statusCallback: webhooks.statusCallback,
      statusCallbackMethod: 'POST',
    });
  }

  async fetchRecordingMedia(recordingSid: string): Promise<TwilioRecordingMedia> {
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`, 'ascii').toString('base64');
    const response = await fetch(`${this.recordingMediaBaseUrl(recordingSid)}.mp3`, {
      headers: { Authorization: `Basic ${auth}` },
    });
    if (!response.ok) {
      throw new Error(`Twilio recording media request failed: ${response.status}`);
    }
    const body = Buffer.from(await response.arrayBuffer());
    return {
      body,
      contentType: response.headers.get('content-type') ?? 'audio/mpeg',
    };
  }

  private recordingMediaBaseUrl(recordingSid: string): string {
    return `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Recordings/${recordingSid}`;
  }

  async validateCredentials(): Promise<boolean> {
    try {
      const authClient = twilio(this.accountSid, this.authToken);
      const account = await authClient.api.v2010.accounts(this.accountSid).fetch();
      if (account.status !== 'active') {
        this.logger.warn(`Twilio account is not active: ${account.status}`);
        return false;
      }

      // Voice Access Tokens are signed with the API key, not the Auth Token.
      // Validate that path explicitly so /health/twilio catches 20101-causing
      // API key or TwiML App drift before the browser tries to register.
      const apiKeySid = this.config.get<string>('TWILIO_API_KEY_SID');
      const apiKeySecret = this.config.get<string>('TWILIO_API_KEY_SECRET');
      if (apiKeySid && apiKeySecret) {
        const keyClient = twilio(apiKeySid, apiKeySecret, { accountSid: this.accountSid });
        await keyClient.api.v2010.accounts(this.accountSid).incomingPhoneNumbers.list({ limit: 1 });
      } else {
        await authClient.api.v2010
          .accounts(this.accountSid)
          .incomingPhoneNumbers.list({ limit: 1 });
      }

      const app = await this.client.applications(this.twimlAppSid).fetch();
      const webhooks = this.defaultWebhookUrls();
      if (app.voiceUrl !== webhooks.outboundVoiceUrl || app.voiceMethod?.toUpperCase() !== 'POST') {
        this.logger.warn(
          `TwiML App ${this.twimlAppSid} Voice URL drift: expected ${webhooks.outboundVoiceUrl}, got ${app.voiceUrl ?? '(unset)'}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      this.logger.warn(`Twilio credential check failed: ${message}`);
      return false;
    }
  }
}
