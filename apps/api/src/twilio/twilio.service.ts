import { Readable } from 'stream';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import twilio, { type Twilio, validateRequest } from 'twilio';

export interface TwilioRecordingMedia {
  stream: Readable;
  contentType: string;
}

export class TwilioRecordingMediaError extends Error {
  constructor(readonly status: number) {
    super(`Twilio recording media request failed: ${status}`);
  }
}

const RECORDING_CALLBACK_EVENTS = ['in-progress', 'completed', 'absent'];

@Injectable()
export class TwilioService implements OnModuleInit {
  private readonly logger = new Logger(TwilioService.name);
  private clientInstance: Twilio | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    // Validate Twilio credentials at startup so misconfiguration is caught
    // immediately rather than at the moment of the first call attempt.
    const valid = await this.validateCredentials();
    if (!valid) {
      this.logger.error(
        'Twilio credentials are invalid or the TwiML App Voice URL is misconfigured. ' +
          'Outbound calls will fail. Run the Twilio diagnostics check and fix the configuration.',
      );
    }
  }

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

  get messagingStatusCallbackUrl(): string {
    return (
      this.config.get<string>('TWILIO_MESSAGING_STATUS_CALLBACK_URL') ??
      `${this.webhookBaseUrl}/webhooks/twilio/messaging/status`
    ).replace(/\/$/, '');
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

  // One browser identity per user, shared by all of their numbers: the web app
  // registers a single Device wherever it is open, and inbound calls to any of
  // the user's numbers ring it.
  voiceIdentity(userId: string): string {
    return `user_${userId.replace(/[^a-zA-Z0-9]/g, '')}`;
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
      throw new TwilioRecordingMediaError(response.status);
    }
    if (!response.body) {
      throw new Error('Twilio recording media response has no body');
    }
    // Stream the MP3 directly to the caller instead of buffering the entire
    // file in server memory. Dual-channel recordings of long calls can exceed
    // 100 MB, which would exhaust RAM on small instances.
    return {
      stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      contentType: response.headers.get('content-type') ?? 'audio/mpeg',
    };
  }

  /** Deletes a recording from Twilio. True when it is gone, including already deleted. */
  async deleteRecording(recordingSid: string): Promise<boolean> {
    try {
      await this.client.recordings(recordingSid).remove();
      return true;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return true;
      throw err;
    }
  }

  /**
   * Starts a dual-channel recording of a call that is already up, reported to
   * the same status callback as <Dial record>. Returns the recording SID.
   */
  async startCallRecording(callSid: string): Promise<string> {
    const recording = await this.client.calls(callSid).recordings.create({
      recordingChannels: 'dual',
      recordingTrack: 'both',
      trim: 'do-not-trim',
      recordingStatusCallback: `${this.webhookBaseUrl}/webhooks/twilio/voice/recording`,
      recordingStatusCallbackMethod: 'POST',
      recordingStatusCallbackEvent: RECORDING_CALLBACK_EVENTS,
    });
    return recording.sid;
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
