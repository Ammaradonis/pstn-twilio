import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { type RedisOptions } from 'ioredis';

export const REDIS_CLIENT = 'REDIS_CLIENT';

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject(REDIS_CLIENT) public readonly client: Redis) {}

  onModuleInit(): void {
    this.client.on('error', (err) => this.logger.error(`Redis error: ${err.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async ping(): Promise<'PONG'> {
    const reply = await this.client.ping();
    if (reply !== 'PONG') {
      throw new Error(`Unexpected Redis ping reply: ${reply}`);
    }
    return reply;
  }
}

export function createRedisClient(config: ConfigService): Redis {
  const url = config.get<string>('REDIS_URL');
  if (!url) {
    throw new Error('REDIS_URL is required');
  }
  const options: RedisOptions = {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  };
  return new Redis(url, options);
}
