import 'reflect-metadata';

import { ArgumentsHost, Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HealthController } from '../health/health.controller';
import { RedisService } from '../redis/redis.service';
import { TwilioService } from '../twilio/twilio.service';

import { databaseUnavailableMessage } from './database-unavailable';
import { PrismaExceptionFilter } from './prisma-exception.filter';
import { PrismaModule } from './prisma.module';
import { PrismaService } from './prisma.service';

const quotaMessage =
  'Invalid prisma.user.findUnique() invocation: ERROR: Your account or project has exceeded the quota. Upgrade your plan to increase limits.';
const options = { clientVersion: '6.2.1' };
const quotaError = () => new Prisma.PrismaClientUnknownRequestError(quotaMessage, options);

afterEach(() => vi.restoreAllMocks());

@Controller('probe')
class QuotaProbeController {
  @Get()
  read() {
    throw quotaError();
  }
}

it('registers the filter globally and sends a 503 JSON response over HTTP', async () => {
  const module = await Test.createTestingModule({
    imports: [PrismaModule],
    controllers: [QuotaProbeController],
  })
    .overrideProvider(PrismaService)
    .useValue({})
    .compile();
  const app = module.createNestApplication();
  try {
    await app.init();
    const response = await request(app.getHttpServer()).get('/probe').expect(503);
    expect(response.body).toMatchObject({
      statusCode: 503,
      message: expect.stringContaining('database usage limit'),
    });
    expect(JSON.stringify(response.body)).not.toContain('prisma.user');
  } finally {
    await app.close();
  }
});

describe('database availability errors', () => {
  it.each([
    quotaError(),
    new Prisma.PrismaClientKnownRequestError(quotaMessage, { ...options, code: 'P2010' }),
    new Prisma.PrismaClientInitializationError(quotaMessage, options.clientVersion),
    new Prisma.PrismaClientUnknownRequestError(
      'Your account or project has exceeded the compute time quota.',
      options,
    ),
  ])('maps quota failures to an actionable 503 without exposing query details', (error) => {
    const handler = vi.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => {});
    const host = {} as ArgumentsHost;
    new PrismaExceptionFilter().catch(error, host);
    const response = handler.mock.calls[0]![0] as ServiceUnavailableException;
    expect(response.getStatus()).toBe(503);
    expect(response.message).toContain('database usage limit');
    expect(response.message).not.toContain('prisma.user');
    expect(handler.mock.calls[0]![1]).toBe(host);
  });

  it('maps connection and pool failures to temporary unavailability', () => {
    expect(
      databaseUnavailableMessage(
        new Prisma.PrismaClientInitializationError('Cannot reach private hostname', '6.2.1'),
      ),
    ).toContain('temporarily unavailable');
    expect(
      databaseUnavailableMessage(
        new Prisma.PrismaClientInitializationError('private hostname', '6.2.1', 'P1001'),
      ),
    ).toContain('temporarily unavailable');
    expect(
      databaseUnavailableMessage(
        new Prisma.PrismaClientKnownRequestError('pool exhausted', { ...options, code: 'P2024' }),
      ),
    ).toContain('temporarily unavailable');
  });

  it('leaves constraint and query bugs to the normal exception handler', () => {
    const error = new Prisma.PrismaClientKnownRequestError('unique constraint', {
      ...options,
      code: 'P2002',
    });
    const handler = vi.spyOn(BaseExceptionFilter.prototype, 'catch').mockImplementation(() => {});
    const host = {} as ArgumentsHost;
    new PrismaExceptionFilter().catch(error, host);
    expect(handler).toHaveBeenCalledWith(error, host);
    expect(databaseUnavailableMessage(new Error(quotaMessage))).toBeNull();
  });
});

describe('database health probe', () => {
  function controller(query: ReturnType<typeof vi.fn>) {
    return new HealthController(
      { $queryRaw: query } as unknown as PrismaService,
      {} as RedisService,
      {} as TwilioService,
    );
  }

  it('returns HTTP 503 on quota exhaustion while process liveness remains healthy', async () => {
    const health = controller(vi.fn().mockRejectedValue(quotaError()));
    await expect(health.db()).rejects.toMatchObject({
      status: 503,
      response: {
        status: 'down',
        checks: {
          db: { status: 'down', message: expect.stringContaining('database usage limit') },
        },
      },
    });
    expect(health.liveness().status).toBe('ok');
  });

  it('does not publish raw database errors on the unauthenticated probe', async () => {
    const health = controller(vi.fn().mockRejectedValue(new Error('private connection details')));
    await expect(health.db()).rejects.toMatchObject({
      status: 503,
      response: { checks: { db: { message: 'The database is unavailable.' } } },
    });
  });

  it('reports recovery after queries succeed again', async () => {
    const query = vi
      .fn()
      .mockRejectedValueOnce(quotaError())
      .mockResolvedValueOnce([{ '?column?': 1 }]);
    const health = controller(query);
    await expect(health.db()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(health.db()).resolves.toMatchObject({
      status: 'ok',
      checks: { db: { status: 'ok' } },
    });
  });
});
