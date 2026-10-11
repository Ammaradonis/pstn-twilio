import { ArgumentsHost, Catch, ServiceUnavailableException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '@prisma/client';

import { databaseUnavailableMessage } from './database-unavailable';

@Catch(
  Prisma.PrismaClientKnownRequestError,
  Prisma.PrismaClientUnknownRequestError,
  Prisma.PrismaClientInitializationError,
)
export class PrismaExceptionFilter extends BaseExceptionFilter {
  override catch(exception: Error, host: ArgumentsHost): void {
    const message = databaseUnavailableMessage(exception);
    super.catch(message ? new ServiceUnavailableException(message) : exception, host);
  }
}
