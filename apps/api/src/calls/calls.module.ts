import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';

import { CallsController } from './calls.controller';
import { CallsService } from './calls.service';

@Module({
  imports: [PrismaModule, AuditModule],
  controllers: [CallsController],
  providers: [CallsService],
  exports: [CallsService],
})
export class CallsModule {}
