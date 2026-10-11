import { Module, Global } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { PrismaExceptionFilter } from './prisma-exception.filter';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService, { provide: APP_FILTER, useClass: PrismaExceptionFilter }],
  exports: [PrismaService],
})
export class PrismaModule {}
