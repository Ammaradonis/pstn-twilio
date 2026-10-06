import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { VoiceAppModule } from '../voice-app/voice-app.module';

import { MessagingWebhookController } from './messaging.controller';
import { MessagingWebhookService } from './messaging.service';
import { TwilioSignatureGuard } from './twilio-signature.guard';
import { VoiceWebhookController } from './voice.controller';
import { VoiceWebhookService } from './voice.service';

@Module({
  imports: [PrismaModule, VoiceAppModule],
  controllers: [MessagingWebhookController, VoiceWebhookController],
  providers: [TwilioSignatureGuard, MessagingWebhookService, VoiceWebhookService],
  exports: [TwilioSignatureGuard],
})
export class WebhooksModule {}
