import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { type PrismaService } from '../prisma/prisma.service';

export interface AuditLogDto {
  id: string;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: string;
}

interface ListInput {
  cursor?: string;
  limit?: number;
  action?: string;
  entityType?: string;
}

interface CursorPayload {
  createdAt: string;
  id: string;
}

function encodeCursor(c: CursorPayload): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(s: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as CursorPayload;
    if (!parsed.createdAt || !parsed.id) return null;
    return parsed;
  } catch {
    return null;
  }
}

@Injectable()
export class AuditLogsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(input: ListInput): Promise<{ items: AuditLogDto[]; nextCursor: string | null }> {
    const limit = input.limit ?? 50;
    const where: Prisma.AuditLogWhereInput = {};
    if (input.action) where.action = input.action;
    if (input.entityType) where.entityType = input.entityType;

    let cursorClause: Prisma.AuditLogWhereInput | undefined;
    if (input.cursor) {
      const decoded = decodeCursor(input.cursor);
      if (decoded) {
        cursorClause = {
          OR: [
            { createdAt: { lt: new Date(decoded.createdAt) } },
            { createdAt: new Date(decoded.createdAt), id: { lt: decoded.id } },
          ],
        };
      }
    }

    const rows = await this.prisma.auditLog.findMany({
      where: cursorClause ? { AND: [where, cursorClause] } : where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    const items = rows.slice(0, limit).map(toDto);
    const nextCursor =
      rows.length > limit
        ? encodeCursor({
            createdAt: items[items.length - 1].createdAt,
            id: items[items.length - 1].id,
          })
        : null;

    return { items, nextCursor };
  }
}

function toDto(row: {
  id: string;
  userId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: Date;
}): AuditLogDto {
  return {
    id: row.id,
    userId: row.userId,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  };
}
