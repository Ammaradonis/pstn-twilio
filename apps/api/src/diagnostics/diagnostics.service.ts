import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebhookProvider } from '@prisma/client';

import { APP_INFO } from '../common/app-info';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TwilioService } from '../twilio/twilio.service';

export type CheckStatus = 'ok' | 'down' | 'degraded';

export interface DiagnosticCheck {
  status: CheckStatus;
  message?: string;
  durationMs?: number;
}

export interface WebhookSnapshot {
  total: number;
  last: {
    eventType: string;
    twilioSid: string | null;
    signatureValid: boolean;
    processedAt: string | null;
    createdAt: string;
  } | null;
  lastError: {
    eventType: string;
    twilioSid: string | null;
    createdAt: string;
  } | null;
}

export interface DiagnosticReport {
  startedAt: string;
  uptimeSeconds: number;
  app: { name: string; version: string };
  environment: {
    nodeEnv: string;
    publicBaseUrl: string | null;
    webhookBaseUrl: string | null;
    webhookBaseIsHttps: boolean;
    corsOrigins: string[];
    defaultCountry: string | null;
  };
  checks: {
    api: DiagnosticCheck;
    db: DiagnosticCheck;
    redis: DiagnosticCheck;
    twilio: DiagnosticCheck;
  };
  webhooks: WebhookSnapshot;
  overallStatus: CheckStatus;
}

@Injectable()
export class DiagnosticsService {
  private readonly logger = new Logger(DiagnosticsService.name);
  private readonly startedAt = Date.now();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly twilio: TwilioService,
  ) {}

  async report(): Promise<DiagnosticReport> {
    const [db, redis, twilio, webhooks] = await Promise.all([
      this.checkDb(),
      this.checkRedis(),
      this.checkTwilio(),
      this.webhookSnapshot(),
    ]);

    const checks = {
      api: { status: 'ok' as const },
      db,
      redis,
      twilio,
    };
    const overallStatus = this.overall(checks);

    const webhookBaseUrl =
      this.config.get<string>('TWILIO_WEBHOOK_BASE_URL') ??
      this.config.get<string>('PUBLIC_BASE_URL') ??
      null;

    return {
      startedAt: new Date(this.startedAt).toISOString(),
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      app: { name: APP_INFO.name, version: APP_INFO.version },
      environment: {
        nodeEnv: this.config.get<string>('NODE_ENV') ?? 'development',
        publicBaseUrl: this.config.get<string>('PUBLIC_BASE_URL') ?? null,
        webhookBaseUrl,
        webhookBaseIsHttps: webhookBaseUrl
          ? webhookBaseUrl.toLowerCase().startsWith('https://')
          : false,
        corsOrigins:
          this.config
            .get<string>('CORS_ORIGINS')
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean) ?? [],
        defaultCountry: this.config.get<string>('TWILIO_DEFAULT_COUNTRY') ?? null,
      },
      checks,
      webhooks,
      overallStatus,
    };
  }

  private async checkDb(): Promise<DiagnosticCheck> {
    const start = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', durationMs: Date.now() - start };
    } catch (err) {
      this.logger.warn(`DB diagnostic failed: ${err instanceof Error ? err.message : 'unknown'}`);
      return {
        status: 'down',
        durationMs: Date.now() - start,
        message: err instanceof Error ? err.message : 'unknown',
      };
    }
  }

  private async checkRedis(): Promise<DiagnosticCheck> {
    const start = Date.now();
    try {
      await this.redis.ping();
      return { status: 'ok', durationMs: Date.now() - start };
    } catch (err) {
      return {
        status: 'down',
        durationMs: Date.now() - start,
        message: err instanceof Error ? err.message : 'unknown',
      };
    }
  }

  private async checkTwilio(): Promise<DiagnosticCheck> {
    const start = Date.now();
    try {
      const ok = await this.twilio.validateCredentials();
      return {
        status: ok ? 'ok' : 'down',
        durationMs: Date.now() - start,
        message: ok ? 'Account active' : 'Twilio credential check failed',
      };
    } catch (err) {
      return {
        status: 'down',
        durationMs: Date.now() - start,
        message: err instanceof Error ? err.message : 'unknown',
      };
    }
  }

  private async webhookSnapshot(): Promise<WebhookSnapshot> {
    try {
      const [total, last, lastError] = await Promise.all([
        this.prisma.webhookEvent.count({ where: { provider: WebhookProvider.TWILIO } }),
        this.prisma.webhookEvent.findFirst({
          where: { provider: WebhookProvider.TWILIO },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.webhookEvent.findFirst({
          where: { provider: WebhookProvider.TWILIO, signatureValid: false },
          orderBy: { createdAt: 'desc' },
        }),
      ]);
      return {
        total,
        last: last
          ? {
              eventType: last.eventType,
              twilioSid: last.twilioSid,
              signatureValid: last.signatureValid,
              processedAt: last.processedAt?.toISOString() ?? null,
              createdAt: last.createdAt.toISOString(),
            }
          : null,
        lastError: lastError
          ? {
              eventType: lastError.eventType,
              twilioSid: lastError.twilioSid,
              createdAt: lastError.createdAt.toISOString(),
            }
          : null,
      };
    } catch (err) {
      this.logger.warn(
        `Webhook snapshot failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      return { total: 0, last: null, lastError: null };
    }
  }

  private overall(checks: Record<'api' | 'db' | 'redis' | 'twilio', DiagnosticCheck>): CheckStatus {
    const statuses = Object.values(checks).map((c) => c.status);
    if (statuses.every((s) => s === 'ok')) return 'ok';
    if (statuses.some((s) => s === 'down')) return 'down';
    return 'degraded';
  }
}
