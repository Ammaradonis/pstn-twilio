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
      const apiKeySid = this.config.get<string>('TWILIO_API_KEY_SID');
      const apiKeySecret = this.config.get<string>('TWILIO_API_KEY_SECRET');
      if (apiKeySid && apiKeySecret) {
        this.clientInstance = twilio(apiKeySid, apiKeySecret, { accountSid: this.accountSid });
      } else {
        this.clientInstance = twilio(this.accountSid, this.authToken);
      }
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
      voiceUrl: `${base}/webhooks/twilio/voice/inbound`,
      voiceFallbackUrl: `${base}/webhooks/twilio/voice/fallback`,
      statusCallback: `${base}/webhooks/twilio/voice/status`,
      smsUrl: `${base}/webhooks/twilio/messaging/inbound`,
      smsFallbackUrl: `${base}/webhooks/twilio/messaging/inbound`,
    };
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
      // Auth Token can always fetch account details; use it for a reliable status check.
      const authClient = twilio(this.accountSid, this.authToken);
      const account = await authClient.api.v2010.accounts(this.accountSid).fetch();
      return account.status === 'active';
    } catch {
      // Fallback: API key with explicit account path (SDK v5 shorthand mis-routes with API keys).
      try {
        await this.client.api.v2010
          .accounts(this.accountSid)
          .incomingPhoneNumbers.list({ limit: 1 });
        return true;
      } catch (subErr) {
        const message = subErr instanceof Error ? subErr.message : 'unknown';
        this.logger.warn(`Twilio credential check failed: ${message}`);
        return false;
      }
    }
  }
}
