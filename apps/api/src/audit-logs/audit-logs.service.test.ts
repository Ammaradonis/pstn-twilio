import { describe, expect, it, vi } from 'vitest';

import { AuditLogsService } from './audit-logs.service';

function makeRow(i: number) {
  return {
    id: `log-${i}`,
    userId: 'u1',
    action: 'number.purchased',
    entityType: 'PhoneNumber',
    entityId: `pn-${i}`,
    ipAddress: '127.0.0.1',
    userAgent: 'vitest',
    metadata: { foo: 'bar' },
    createdAt: new Date(`2026-05-19T00:0${i}:00Z`),
  };
}

describe('AuditLogsService.list', () => {
  it('returns items in descending order and no cursor when under the limit', async () => {
    const rows = [makeRow(2), makeRow(1)];
    const prisma = { auditLog: { findMany: vi.fn().mockResolvedValue(rows) } };
    const service = new AuditLogsService(prisma as any);
    const result = await service.list({ limit: 10 });
    expect(result.items.map((r) => r.id)).toEqual(['log-2', 'log-1']);
    expect(result.nextCursor).toBeNull();
  });

  it('returns a nextCursor when one extra row is fetched', async () => {
    const rows = [makeRow(3), makeRow(2), makeRow(1)];
    const prisma = { auditLog: { findMany: vi.fn().mockResolvedValue(rows) } };
    const service = new AuditLogsService(prisma as any);
    const result = await service.list({ limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).not.toBeNull();
  });

  it('applies action filter through prisma where clause', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { auditLog: { findMany } };
    const service = new AuditLogsService(prisma as any);
    await service.list({ limit: 5, action: 'number.purchased', entityType: 'PhoneNumber' });
    const call = findMany.mock.calls[0][0];
    expect(call.where).toEqual({ action: 'number.purchased', entityType: 'PhoneNumber' });
  });

  it('decodes a base64url cursor and applies it as a "less than" clause', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { auditLog: { findMany } };
    const service = new AuditLogsService(prisma as any);
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: '2026-05-19T00:05:00Z', id: 'log-9' }),
      'utf8',
    ).toString('base64url');
    await service.list({ limit: 5, cursor });
    const call = findMany.mock.calls[0][0];
    expect(call.where.AND).toBeDefined();
    expect(call.where.AND[1].OR[0].createdAt).toBeInstanceOf(Object);
  });

  it('ignores a malformed cursor', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { auditLog: { findMany } };
    const service = new AuditLogsService(prisma as any);
    await service.list({ limit: 5, cursor: '!!!not-base64!!!' });
    const call = findMany.mock.calls[0][0];
    expect(call.where.AND).toBeUndefined();
  });
});
