import { createHmac, timingSafeEqual } from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webpush from 'web-push';

import { PrismaService } from '../prisma/prisma.service';

// What the voice app's service worker shows. It renders these fields as they
// are, so the server decides the wording.
export interface VoicePushPayload {
  type: 'incoming-call' | 'call-answered' | 'missed-call' | 'voicemail' | 'message';
  title: string;
  body: string;
  // Notifications with the same tag replace each other.
  tag: string;
  // Opened when the notification is tapped.
  url: string;
  callSid?: string;
  // Lets the notification's Decline button act without a signed-in session.
  actionToken?: string;
  requireInteraction?: boolean;
  renotify?: boolean;
  silent?: boolean;
}

interface SendOptions {
  // Seconds the push service keeps an undelivered message.
  ttl: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
  // Skip this device (the one that caused the event).
  exceptDeviceId?: string;
}

const ACTION_TOKEN_TTL_MS = 2 * 60_000;

@Injectable()
export class VoicePushService {
  private readonly logger = new Logger(VoicePushService.name);
  private configured: boolean | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  get publicKey(): string | null {
    return this.enabled() ? (this.config.get<string>('VAPID_PUBLIC_KEY') ?? null) : null;
  }

  enabled(): boolean {
    if (this.configured !== null) return this.configured;
    const publicKey = this.config.get<string>('VAPID_PUBLIC_KEY');
    const privateKey = this.config.get<string>('VAPID_PRIVATE_KEY');
    if (!publicKey || !privateKey) {
      this.configured = false;
      return false;
    }
    try {
      webpush.setVapidDetails(
        this.config.get<string>('VAPID_SUBJECT') ?? 'https://bestsoftphone.site',
        publicKey,
        privateKey,
      );
      this.configured = true;
    } catch (err) {
      this.logger.error(
        `Web Push is disabled: invalid VAPID keys (${err instanceof Error ? err.message : 'unknown'})`,
      );
      this.configured = false;
    }
    return this.configured;
  }

  /** Never throws: notifications are best effort. */
  async sendToUser(userId: string, payload: VoicePushPayload, options: SendOptions): Promise<void> {
    if (!this.enabled()) return;
    try {
      const devices = await this.prisma.userDevice.findMany({
        where: {
          userId,
          pushEndpoint: { not: null },
          ...(options.exceptDeviceId ? { id: { not: options.exceptDeviceId } } : {}),
        },
        select: { id: true, pushEndpoint: true, pushP256dh: true, pushAuth: true },
      });
      const body = JSON.stringify(payload);
      await Promise.all(
        devices.map(async (device) => {
          if (!device.pushEndpoint || !device.pushP256dh || !device.pushAuth) return;
          try {
            await webpush.sendNotification(
              {
                endpoint: device.pushEndpoint,
                keys: { p256dh: device.pushP256dh, auth: device.pushAuth },
              },
              body,
              { TTL: options.ttl, urgency: options.urgency },
            );
          } catch (err) {
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              // The browser dropped the subscription (app removed, permission revoked).
              await this.prisma.userDevice
                .update({
                  where: { id: device.id },
                  data: { pushEndpoint: null, pushP256dh: null, pushAuth: null },
                })
                .catch(() => undefined);
              return;
            }
            this.logger.warn(
              `Web Push to device ${device.id} failed: ${status ?? ''} ${
                err instanceof Error ? err.message : 'unknown'
              }`,
            );
          }
        }),
      );
    } catch (err) {
      this.logger.warn(`Web Push failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }
  }

  /** A short-lived token that lets a notification button decline one call. */
  actionToken(userId: string, callSid: string, now = Date.now()): string {
    const exp = now + ACTION_TOKEN_TTL_MS;
    const body = `${callSid}.${userId}.${exp}`;
    return `${body}.${this.sign(body)}`;
  }

  verifyActionToken(token: string, now = Date.now()): { userId: string; callSid: string } | null {
    const parts = token.split('.');
    if (parts.length !== 4) return null;
    const [callSid, userId, expRaw, signature] = parts as [string, string, string, string];
    const exp = Number(expRaw);
    if (!Number.isFinite(exp) || exp < now) return null;
    const expected = Buffer.from(this.sign(`${callSid}.${userId}.${expRaw}`));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return { userId, callSid };
  }

  private sign(body: string): string {
    const secret = this.config.getOrThrow<string>('JWT_SECRET');
    return createHmac('sha256', `voice-push:${secret}`).update(body).digest('base64url');
  }
}
