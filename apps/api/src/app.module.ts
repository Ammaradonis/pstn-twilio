import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';

import { AuditModule } from './audit/audit.module';
import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { AuthModule } from './auth/auth.module';
import { CallsModule } from './calls/calls.module';
import { HttpLoggerMiddleware } from './common/http-logger.middleware';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { DiagnosticsModule } from './diagnostics/diagnostics.module';
import { HealthModule } from './health/health.module';
import { MessagesModule } from './messages/messages.module';
import { NumbersModule } from './numbers/numbers.module';
import { PrismaModule } from './prisma/prisma.module';
import { RealtimeModule } from './realtime/realtime.module';
import { RedisModule } from './redis/redis.module';
import { TwilioModule } from './twilio/twilio.module';
import { VoiceModule } from './voice/voice.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      { ttl: 60000, limit: 10, name: 'short' },
      { ttl: 900000, limit: 100, name: 'medium' },
    ]),
    PrismaModule,
    AuditModule,
    AuthModule,
    HealthModule,
    RedisModule,
    TwilioModule,
    RealtimeModule,
    NumbersModule,
    MessagesModule,
    VoiceModule,
    CallsModule,
    WebhooksModule,
    DiagnosticsModule,
    AuditLogsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware, HttpLoggerMiddleware).forRoutes('*');
  }
}
