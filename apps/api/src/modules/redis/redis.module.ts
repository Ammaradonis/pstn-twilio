import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { REDIS_CLIENT, RedisService, createRedisClient } from './redis.service';

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => createRedisClient(config),
    },
    RedisService,
  ],
  exports: [RedisService, REDIS_CLIENT],
})
export class RedisModule {}
