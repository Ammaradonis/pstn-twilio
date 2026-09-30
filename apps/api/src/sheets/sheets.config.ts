import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Sheets/Gmail settings. Uses its own OAuth client, GOOGLE_CLOUD_CLIENT_ID /
 * GOOGLE_CLOUD_CLIENT_SECRET (Google Cloud project local-gmail-510114), not the
 * Calendar client (GOOGLE_CLIENT_ID). That project needs the Sheets, Drive and
 * Gmail APIs enabled and the redirect URI below registered on the client.
 */
@Injectable()
export class SheetsConfig {
  constructor(private readonly config: ConfigService) {}

  private get(key: string): string | undefined {
    const value = this.config.get<string>(key)?.trim();
    return value ? value : undefined;
  }

  get googleClientId(): string | undefined {
    return this.get('GOOGLE_CLOUD_CLIENT_ID');
  }

  get googleClientSecret(): string | undefined {
    return this.get('GOOGLE_CLOUD_CLIENT_SECRET');
  }

  get tokenEncryptionKey(): string | undefined {
    return this.get('TOKEN_ENCRYPTION_KEY');
  }

  get stateSigningSecret(): string | undefined {
    return this.get('JWT_SECRET');
  }

  get publicApiBaseUrl(): string {
    return (
      this.get('TWILIO_WEBHOOK_BASE_URL') ??
      this.get('PUBLIC_BASE_URL') ??
      'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  // Under /webhooks so it sits outside the /api prefix and the JWT guard,
  // like the Calendar callback.
  get oauthRedirectUri(): string {
    return (
      this.get('GOOGLE_SHEETS_OAUTH_REDIRECT_URI') ??
      `${this.publicApiBaseUrl}/webhooks/google-sheets/oauth/callback`
    );
  }

  get webAppUrl(): string {
    return (this.get('WEB_APP_URL') ?? 'https://app.bestsoftphone.site').replace(/\/$/, '');
  }

  /** The "U.S. Conquest" workbook, used to check and learn city time zones. */
  get conquestSheetId(): string {
    return this.get('US_CONQUEST_SHEET_ID') ?? '1hEen_n9M27n5bjyXpsnaHXpvG7S5eHHmPl6HG2LhRnM';
  }

  /** API settings that still need to be set; empty when ready. */
  missing(): string[] {
    const required: [string, string | undefined][] = [
      ['GOOGLE_CLOUD_CLIENT_ID', this.googleClientId],
      ['GOOGLE_CLOUD_CLIENT_SECRET', this.googleClientSecret],
      ['TOKEN_ENCRYPTION_KEY', this.tokenEncryptionKey],
      ['JWT_SECRET', this.stateSigningSecret],
    ];
    return required.filter(([, value]) => !value).map(([name]) => name);
  }

  isConfigured(): boolean {
    return this.missing().length === 0;
  }
}
