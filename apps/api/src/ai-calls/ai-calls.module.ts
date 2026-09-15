import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';

import { AiCallingConfig } from './ai-calling.config';
import {
  GoogleCalendarOAuthController,
  VapiSecretGuard,
  VapiWebhookController,
} from './ai-calls-webhooks.controller';
import { AiCallsController, GoogleCalendarController } from './ai-calls.controller';
import { AiCallsService } from './ai-calls.service';
import { GoogleCalendarService } from './google-calendar.service';
import { InboundCallsService } from './inbound-calls.service';
import { VapiClient } from './vapi.client';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [
    AiCallsController,
    GoogleCalendarController,
    VapiWebhookController,
    GoogleCalendarOAuthController,
  ],
  providers: [
    AiCallingConfig,
    AiCallsService,
    GoogleCalendarService,
    InboundCallsService,
    VapiClient,
    VapiSecretGuard,
  ],
})
export class AiCallsModule {}
