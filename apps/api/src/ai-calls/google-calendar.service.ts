import { randomUUID } from 'crypto';

import { Injectable, Logger } from '@nestjs/common';

import {
  decryptSecret,
  encryptSecret,
  signPayload,
  verifySignedPayload,
} from '../common/secret-box';
import { PrismaService } from '../prisma/prisma.service';

import { AiCallingConfig } from './ai-calling.config';
import type { BusyInterval } from './consult-slots';

const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.freebusy',
];
const STATE_TTL_MS = 15 * 60_000;

export class CalendarUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarUnavailableError';
  }
}

export interface ConsultEventInput {
  start: Date;
  end: Date;
  timeZone: string;
  summary: string;
  description: string;
  attendeeEmail: string;
}

export interface CreatedConsultEvent {
  eventId: string;
  meetUrl: string | null;
  htmlLink: string | null;
}

type OAuthState = { u: string; exp: number; n: string };

@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);
  private readonly accessTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AiCallingConfig,
  ) {}

  isConfigured(): boolean {
    return Boolean(
      this.settings.googleClientId &&
      this.settings.googleClientSecret &&
      this.settings.tokenEncryptionKey &&
      this.settings.stateSigningSecret,
    );
  }

  async status(userId: string): Promise<{ connected: boolean; email: string | null }> {
    const connection = await this.prisma.googleCalendarConnection.findUnique({ where: { userId } });
    return { connected: Boolean(connection), email: connection?.googleEmail ?? null };
  }

  authorizationUrl(userId: string): string {
    if (!this.isConfigured()) {
      throw new CalendarUnavailableError('Google Calendar access is not configured on the API.');
    }
    const state = signPayload(
      { u: userId, exp: Date.now() + STATE_TTL_MS, n: randomUUID() } satisfies OAuthState,
      this.settings.stateSigningSecret!,
    );
    const params = new URLSearchParams({
      client_id: this.settings.googleClientId!,
      redirect_uri: this.settings.googleRedirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      // Always show consent so Google issues a refresh token.
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  // Exchanges the OAuth code and stores the refresh token. Returns the user id.
  async completeAuthorization(code: string, state: string): Promise<string> {
    if (!this.isConfigured()) {
      throw new CalendarUnavailableError('Google Calendar access is not configured on the API.');
    }
    const payload = verifySignedPayload<OAuthState>(state, this.settings.stateSigningSecret!);
    if (!payload || payload.exp < Date.now()) {
      throw new CalendarUnavailableError('The Google sign-in link expired. Try connecting again.');
    }

    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.settings.googleRedirectUri,
    });
    if (!tokens.refresh_token) {
      throw new CalendarUnavailableError(
        'Google did not return offline access. Remove the app at myaccount.google.com/permissions and connect again.',
      );
    }
    const granted = String(tokens.scope ?? '');
    if (!granted.includes('calendar.events') || !granted.includes('calendar.freebusy')) {
      throw new CalendarUnavailableError(
        'Calendar permissions were not granted. Connect again and allow calendar access.',
      );
    }

    await this.prisma.googleCalendarConnection.upsert({
      where: { userId: payload.u },
      create: {
        userId: payload.u,
        googleEmail: emailFromIdToken(tokens.id_token),
        refreshTokenEncrypted: encryptSecret(
          tokens.refresh_token,
          this.settings.tokenEncryptionKey!,
        ),
        scopes: granted,
      },
      update: {
        googleEmail: emailFromIdToken(tokens.id_token),
        refreshTokenEncrypted: encryptSecret(
          tokens.refresh_token,
          this.settings.tokenEncryptionKey!,
        ),
        scopes: granted,
      },
    });
    this.accessTokens.set(payload.u, {
      token: tokens.access_token,
      expiresAt: Date.now() + (Number(tokens.expires_in ?? 3600) - 60) * 1000,
    });
    return payload.u;
  }

  async disconnect(userId: string): Promise<void> {
    const connection = await this.prisma.googleCalendarConnection.findUnique({ where: { userId } });
    if (!connection) return;
    this.accessTokens.delete(userId);
    await this.prisma.googleCalendarConnection.delete({ where: { userId } });
    try {
      const refreshToken = decryptSecret(
        connection.refreshTokenEncrypted,
        this.settings.tokenEncryptionKey!,
      );
      await fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }),
      });
    } catch (err) {
      this.logger.warn(`Google token revoke failed: ${(err as Error).message}`);
    }
  }

  async busyIntervals(userId: string, from: Date, to: Date): Promise<BusyInterval[]> {
    const { token, calendarId } = await this.accessToken(userId);
    const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeMin: from.toISOString(),
        timeMax: to.toISOString(),
        items: [{ id: calendarId }],
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }>;
      error?: { message?: string };
    };
    if (!res.ok) {
      throw new CalendarUnavailableError(
        `Google free/busy failed: ${body.error?.message ?? res.status}`,
      );
    }
    const calendar = body.calendars?.[calendarId];
    if (!calendar || (calendar.errors && calendar.errors.length > 0)) {
      throw new CalendarUnavailableError('Google did not return availability for the calendar.');
    }
    return (calendar.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }

  async createConsultEvent(userId: string, input: ConsultEventInput): Promise<CreatedConsultEvent> {
    const { token, calendarId } = await this.accessToken(userId);
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
    );
    url.searchParams.set('conferenceDataVersion', '1');
    url.searchParams.set('sendUpdates', 'all');
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: input.summary,
        description: input.description,
        start: { dateTime: input.start.toISOString(), timeZone: input.timeZone },
        end: { dateTime: input.end.toISOString(), timeZone: input.timeZone },
        attendees: [{ email: input.attendeeEmail }],
        conferenceData: {
          createRequest: {
            requestId: randomUUID(),
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
        reminders: { useDefault: true },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      id?: string;
      hangoutLink?: string;
      htmlLink?: string;
      conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
      error?: { message?: string };
    };
    if (!res.ok || !body.id) {
      throw new CalendarUnavailableError(
        `Google event creation failed: ${body.error?.message ?? res.status}`,
      );
    }
    const meetUrl =
      body.hangoutLink ??
      body.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video')?.uri ??
      null;
    return { eventId: body.id, meetUrl, htmlLink: body.htmlLink ?? null };
  }

  private async accessToken(userId: string): Promise<{ token: string; calendarId: string }> {
    const connection = await this.prisma.googleCalendarConnection.findUnique({ where: { userId } });
    if (!connection) throw new CalendarUnavailableError('Google Calendar is not connected.');
    if (!this.isConfigured()) {
      throw new CalendarUnavailableError('Google Calendar access is not configured on the API.');
    }
    const cached = this.accessTokens.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return { token: cached.token, calendarId: connection.calendarId };
    }
    const refreshToken = decryptSecret(
      connection.refreshTokenEncrypted,
      this.settings.tokenEncryptionKey!,
    );
    const tokens = await this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    this.accessTokens.set(userId, {
      token: tokens.access_token,
      expiresAt: Date.now() + (Number(tokens.expires_in ?? 3600) - 60) * 1000,
    });
    return { token: tokens.access_token, calendarId: connection.calendarId };
  }

  private async tokenRequest(params: Record<string, string>): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    id_token?: string;
  }> {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.settings.googleClientId!,
        client_secret: this.settings.googleClientSecret!,
        ...params,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !body.access_token) {
      // invalid_grant: the refresh token was revoked or expired.
      throw new CalendarUnavailableError(
        body.error === 'invalid_grant'
          ? 'Google Calendar access was revoked or expired. Reconnect it in Settings.'
          : `Google token request failed: ${body.error_description ?? body.error ?? res.status}`,
      );
    }
    return body as { access_token: string };
  }
}

// The token endpoint response comes straight from Google over TLS, so the
// ID token's claims can be read without re-verifying its signature.
function emailFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      email?: string;
    };
    return claims.email ?? null;
  } catch {
    return null;
  }
}
