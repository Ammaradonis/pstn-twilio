import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Sheets/Gmail settings. Reuses the Calendar OAuth client
 * (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET); its Google Cloud project needs the
 * Sheets, Drive and Gmail APIs enabled and the redirect URI below registered.
 */
@Injectable()
export class SheetsConfig {
  constructor(private readonly config: ConfigService) {}

  private get(key: string): string | undefined {
    const value = this.config.get<string>(key)?.trim();
    return value ? value : undefined;
  }

  get googleClientId(): string | undefined {
    return this.get('GOOGLE_CLIENT_ID');
  }

  get googleClientSecret(): string | undefined {
    return this.get('GOOGLE_CLIENT_SECRET');
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

  isConfigured(): boolean {
    return Boolean(
      this.googleClientId &&
      this.googleClientSecret &&
      this.tokenEncryptionKey &&
      this.stateSigningSecret,
    );
  }
}
