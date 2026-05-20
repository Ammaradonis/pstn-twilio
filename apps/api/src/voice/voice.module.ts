import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';

import { VoiceController } from './voice.controller';
import { VoiceService } from './voice.service';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [VoiceController],
  providers: [VoiceService],
  exports: [VoiceService],
})
export class VoiceModule {}
