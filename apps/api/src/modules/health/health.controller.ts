import { Controller, Get } from '@nestjs/common';
import type { HealthStatusDto } from '@pstn-twilio/shared';

import { type PrismaService } from '../prisma/prisma.service';
import { type RedisService } from '../redis/redis.service';
import { type TwilioService } from '../twilio/twilio.service';

@Controller('health')
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly twilio: TwilioService,
  ) {}

  private uptimeSeconds(): number {
    return Math.round((Date.now() - this.startedAt) / 1000);
  }

  private now(): string {
    return new Date().toISOString();
  }

  @Get()
  liveness(): HealthStatusDto {
    return {
      status: 'ok',
      checks: { api: { status: 'ok' } },
      uptimeSeconds: this.uptimeSeconds(),
      timestamp: this.now(),
    };
  }

  @Get('db')
  async db(): Promise<HealthStatusDto> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        status: 'ok',
        checks: { db: { status: 'ok' } },
        uptimeSeconds: this.uptimeSeconds(),
        timestamp: this.now(),
      };
    } catch (err) {
      return {
        status: 'down',
        checks: {
          db: {
            status: 'down',
            message: err instanceof Error ? err.message : 'unknown',
          },
        },
        uptimeSeconds: this.uptimeSeconds(),
        timestamp: this.now(),
      };
    }
  }

  @Get('redis')
  async redisCheck(): Promise<HealthStatusDto> {
    try {
      await this.redis.ping();
      return {
        status: 'ok',
        checks: { redis: { status: 'ok' } },
        uptimeSeconds: this.uptimeSeconds(),
        timestamp: this.now(),
      };
    } catch (err) {
      return {
        status: 'down',
        checks: {
          redis: {
            status: 'down',
            message: err instanceof Error ? err.message : 'unknown',
          },
        },
        uptimeSeconds: this.uptimeSeconds(),
        timestamp: this.now(),
      };
    }
  }

  @Get('twilio')
  async twilioCheck(): Promise<HealthStatusDto> {
    const ok = await this.twilio.validateCredentials();
    return {
      status: ok ? 'ok' : 'down',
      checks: { twilio: { status: ok ? 'ok' : 'down' } },
      uptimeSeconds: this.uptimeSeconds(),
      timestamp: this.now(),
    };
  }
}
