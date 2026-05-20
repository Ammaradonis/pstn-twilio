import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { type PrismaService } from '../prisma/prisma.service';

interface AuditLogData {
  userId?: string;
  action: string;
  entityType: string;
  entityId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: unknown;
}

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async log(data: AuditLogData) {
    const { metadata, ...rest } = data;
    await this.prisma.auditLog.create({
      data: {
        ...rest,
        ...(metadata === undefined ? {} : { metadata: metadata as Prisma.InputJsonValue }),
      },
    });
  }
}
