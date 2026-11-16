import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';

import { VoicemailDropController, VoicemailDropMediaController } from './voicemail-drop.controller';
import { VoicemailDropService } from './voicemail-drop.service';

/** The Dial page's "Drop voicemail": the recorded message and dropping it on a call. */
@Module({
  imports: [AuditModule],
  controllers: [VoicemailDropController, VoicemailDropMediaController],
  providers: [VoicemailDropService],
})
export class VoicemailDropModule {}
