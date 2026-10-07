import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { MessagesModule } from '../messages/messages.module';
import { TwilioSignatureGuard } from '../webhooks/twilio-signature.guard';

import { VoiceAppCallsService } from './voice-app-calls.service';
import { VoiceAppContactsService } from './voice-app-contacts.service';
import { VoiceAppDevicesService } from './voice-app-devices.service';
import { VoiceAppSettingsService } from './voice-app-settings.service';
import {
  VoiceAppGreetingController,
  VoiceAppWebhooksController,
} from './voice-app-webhooks.controller';
import { VoiceAppContext, VoiceExperienceGuard } from './voice-app.context';
import { VoiceAppController, VoiceAppPushActionsController } from './voice-app.controller';
import { VoiceAppService } from './voice-app.service';
import { VoicePushService } from './voice-push.service';

/**
 * The phone-style app for users whose experience is "voice". Its call
 * routing is used by the Twilio voice and messaging webhooks.
 */
@Module({
  imports: [AuditModule, MessagesModule],
  controllers: [
    VoiceAppController,
    VoiceAppPushActionsController,
    VoiceAppWebhooksController,
    VoiceAppGreetingController,
  ],
  providers: [
    TwilioSignatureGuard,
    VoiceExperienceGuard,
    VoiceAppContext,
    VoicePushService,
    VoiceAppCallsService,
    VoiceAppSettingsService,
    VoiceAppContactsService,
    VoiceAppDevicesService,
    VoiceAppService,
  ],
  exports: [VoiceAppCallsService],
})
export class VoiceAppModule {}
