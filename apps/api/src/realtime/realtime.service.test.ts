import { describe, expect, it, vi } from 'vitest';

import { RealtimeService } from './realtime.service';

function build(owners: Record<string, string | null>) {
  const gateway = {
    emitToOwnersAnd: vi.fn(),
    emitToUser: vi.fn(),
  };
  const prisma = {
    phoneNumber: {
      findUnique: vi.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id in owners ? { userId: owners[where.id] } : null),
      ),
    },
  };
  return { service: new RealtimeService(gateway as never, prisma as never), gateway, prisma };
}

const message = { id: 'm1' } as never;

describe('RealtimeService', () => {
  it("sends a number's events to owners and the user it belongs to", async () => {
    const { service, gateway } = build({ pn1: 'u2' });
    service.smsReceived({ numberId: 'pn1', message });
    await vi.waitFor(() =>
      expect(gateway.emitToOwnersAnd).toHaveBeenCalledWith('u2', 'sms.received', {
        numberId: 'pn1',
        message,
      }),
    );
  });

  it('sends events without a number only to owners', () => {
    const { service, gateway } = build({});
    service.callStatusUpdated({ numberId: null, call: {} as never });
    service.aiCallUpdated({ aiCall: {} as never });
    expect(gateway.emitToOwnersAnd).toHaveBeenNthCalledWith(
      1,
      null,
      'call.status.updated',
      expect.anything(),
    );
    expect(gateway.emitToOwnersAnd).toHaveBeenNthCalledWith(
      2,
      null,
      'ai-call.updated',
      expect.anything(),
    );
  });

  it('keeps events for one number in order and looks the owner up once', async () => {
    const { service, gateway, prisma } = build({ pn1: 'u2' });
    service.smsSent({ numberId: 'pn1', message });
    service.smsStatusUpdated({ numberId: 'pn1', message });
    await vi.waitFor(() => expect(gateway.emitToOwnersAnd).toHaveBeenCalledTimes(2));
    expect(gateway.emitToOwnersAnd.mock.calls.map((c) => c[1])).toEqual([
      'sms.sent',
      'sms.status.updated',
    ]);
    expect(prisma.phoneNumber.findUnique).toHaveBeenCalledTimes(1);
  });

  it('sends voice app sync events to the user only', () => {
    const { service, gateway } = build({});
    service.voiceAppSync('u2', ['contacts']);
    expect(gateway.emitToUser).toHaveBeenCalledWith('u2', 'voice-app.sync', {
      kinds: ['contacts'],
    });
  });
});
