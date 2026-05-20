import { Injectable, Logger } from '@nestjs/common';
import { type ConfigService } from '@nestjs/config';
import twilio, { type Twilio } from 'twilio';

@Injectable()
export class TwilioService {
  private readonly logger = new Logger(TwilioService.name);
  private clientInstance: Twilio | null = null;

  constructor(private readonly config: ConfigService) {}

  get client(): Twilio {
    if (!this.clientInstance) {
      const sid = this.config.get<string>('TWILIO_ACCOUNT_SID');
      const token = this.config.get<string>('TWILIO_AUTH_TOKEN');
      if (!sid || !token) {
        throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required');
      }
      this.clientInstance = twilio(sid, token);
    }
    return this.clientInstance;
  }

  get authToken(): string {
    const token = this.config.get<string>('TWILIO_AUTH_TOKEN');
    if (!token) {
      throw new Error('TWILIO_AUTH_TOKEN is required');
    }
    return token;
  }

  async validateCredentials(): Promise<boolean> {
    try {
      const sid = this.config.get<string>('TWILIO_ACCOUNT_SID');
      if (!sid) return false;
      const account = await this.client.api.v2010.accounts(sid).fetch();
      return account.status === 'active';
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      this.logger.warn(`Twilio credential check failed: ${message}`);
      return false;
    }
  }
}
