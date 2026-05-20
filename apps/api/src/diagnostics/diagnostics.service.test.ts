import { describe, expect, it, vi } from 'vitest';

import { DiagnosticsService } from './diagnostics.service';

function buildService(
  overrides: {
    config?: Partial<{
      NODE_ENV: string;
      PUBLIC_BASE_URL: string;
      TWILIO_WEBHOOK_BASE_URL: string;
      CORS_ORIGINS: string;
      TWILIO_DEFAULT_COUNTRY: string;
    }>;
    prisma?: any;
    redis?: any;
    twilio?: any;
  } = {},
) {
  const configValues: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'https://api.example.com',
    TWILIO_WEBHOOK_BASE_URL: 'https://api.example.com',
    CORS_ORIGINS: 'https://app.example.com, https://admin.example.com',
    TWILIO_DEFAULT_COUNTRY: 'US',
    ...overrides.config,
  };
  const config = {
    get: vi.fn((key: string) => configValues[key]),
  };
  const prisma = overrides.prisma ?? {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    webhookEvent: {
      count: vi.fn().mockResolvedValue(3),
      findFirst: vi.fn().mockImplementation(({ where }: any) => {
        if (where.signatureValid === false) return Promise.resolve(null);
        return Promise.resolve({
          eventType: 'voice.inbound',
          twilioSid: 'CA123',
          signatureValid: true,
          processedAt: new Date('2026-05-19T00:00:00Z'),
          createdAt: new Date('2026-05-19T00:00:01Z'),
        });
      }),
    },
  };
  const redis = overrides.redis ?? { ping: vi.fn().mockResolvedValue('PONG') };
  const twilio = overrides.twilio ?? { validateCredentials: vi.fn().mockResolvedValue(true) };
  return {
    service: new DiagnosticsService(config as any, prisma, redis, twilio),
    config,
    prisma,
    redis,
    twilio,
  };
}

describe('DiagnosticsService.report', () => {
  it('returns an "ok" overall status when every check is healthy', async () => {
    const { service } = buildService();
    const report = await service.report();
    expect(report.overallStatus).toBe('ok');
    expect(report.checks.api.status).toBe('ok');
    expect(report.checks.db.status).toBe('ok');
    expect(report.checks.redis.status).toBe('ok');
    expect(report.checks.twilio.status).toBe('ok');
    expect(report.environment.webhookBaseIsHttps).toBe(true);
    expect(report.environment.corsOrigins).toEqual([
      'https://app.example.com',
      'https://admin.example.com',
    ]);
    expect(report.webhooks.total).toBe(3);
    expect(report.webhooks.last?.eventType).toBe('voice.inbound');
    expect(report.webhooks.lastError).toBeNull();
  });

  it('downgrades the overall status to "down" when any check is down', async () => {
    const { service } = buildService({
      twilio: { validateCredentials: vi.fn().mockResolvedValue(false) },
    });
    const report = await service.report();
    expect(report.checks.twilio.status).toBe('down');
    expect(report.overallStatus).toBe('down');
  });

  it('flags non-HTTPS webhook base URL', async () => {
    const { service } = buildService({
      config: {
        PUBLIC_BASE_URL: 'http://webfitalchemist.online',
        TWILIO_WEBHOOK_BASE_URL: 'http://webfitalchemist.online',
      },
    });
    const report = await service.report();
    expect(report.environment.webhookBaseIsHttps).toBe(false);
  });

  it('reports the last invalid signature event when present', async () => {
    const findFirst = vi.fn().mockImplementation(({ where }: any) => {
      if (where.signatureValid === false) {
        return Promise.resolve({
          eventType: 'voice.inbound',
          twilioSid: 'CA-bad',
          signatureValid: false,
          processedAt: null,
          createdAt: new Date('2026-05-19T00:00:00Z'),
        });
      }
      return Promise.resolve(null);
    });
    const { service } = buildService({
      prisma: {
        $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
        webhookEvent: {
          count: vi.fn().mockResolvedValue(7),
          findFirst,
        },
      },
    });
    const report = await service.report();
    expect(report.webhooks.lastError?.twilioSid).toBe('CA-bad');
  });
});
