import { describe, expect, it, vi } from 'vitest';

import { VoiceAppContactsService } from './voice-app-contacts.service';

const actor = { userId: 'u1', email: 'test@example.com', role: 'OPERATOR' as const };

function build(existing: Array<Record<string, unknown>> = []) {
  const prisma = {
    contact: {
      findMany: vi.fn().mockResolvedValue(existing),
      createMany: vi.fn().mockImplementation((args) => ({ op: 'createMany', args })),
      update: vi.fn().mockImplementation((args) => ({ op: 'update', args })),
    },
    contactPhone: {
      createMany: vi.fn().mockImplementation((args) => ({ op: 'phones', args })),
    },
    $transaction: vi.fn().mockResolvedValue([]),
  };
  const realtime = { voiceAppSync: vi.fn() };
  return {
    service: new VoiceAppContactsService(prisma as never, realtime as never),
    prisma,
    realtime,
  };
}

describe('VoiceAppContactsService.import', () => {
  it('creates new contacts with normalized phone numbers', async () => {
    const { service, prisma, realtime } = build();
    const result = await service.import(actor, {
      source: 'device',
      contacts: [
        { name: 'Ana Ruiz', phones: [{ number: '(415) 555-0100', label: 'mobile' }] },
        { name: '', phones: [{ number: '415 555 0177' }] },
        { name: 'No phone', phones: [] },
        { name: 'Bad phone', phones: [{ number: '12' }] },
      ],
    });
    expect(result).toEqual({ created: 2, updated: 0, skipped: 2 });
    const contacts = prisma.contact.createMany.mock.calls[0][0].data;
    expect(contacts.map((c: { name: string }) => c.name)).toEqual(['Ana Ruiz', '+14155550177']);
    expect(contacts[0].source).toBe('device');
    const phones = prisma.contactPhone.createMany.mock.calls[0][0].data;
    expect(phones).toEqual([
      expect.objectContaining({ e164: '+14155550100', label: 'mobile', userId: 'u1' }),
      expect.objectContaining({ e164: '+14155550177', label: null }),
    ]);
    expect(realtime.voiceAppSync).toHaveBeenCalledWith('u1', ['contacts']);
  });

  it('merges into a contact that already has the number instead of duplicating', async () => {
    const { service, prisma } = build([
      {
        id: 'c1',
        name: 'Ana',
        email: null,
        company: null,
        phones: [{ e164: '+14155550100', label: 'mobile' }],
      },
    ]);
    const result = await service.import(actor, {
      source: 'vcard',
      contacts: [
        {
          name: 'Ana Ruiz',
          email: 'ana@example.com',
          phones: [{ number: '+1 415 555 0100' }, { number: '+1 415 555 0123', label: 'Work' }],
        },
        { name: 'ana', phones: [{ number: '+14155550100' }] },
      ],
    });
    expect(result).toEqual({ created: 0, updated: 1, skipped: 1 });
    expect(prisma.contact.createMany.mock.calls[0][0].data).toEqual([]);
    expect(prisma.contactPhone.createMany.mock.calls[0][0].data).toEqual([
      { contactId: 'c1', userId: 'u1', e164: '+14155550123', label: 'work' },
    ]);
    expect(prisma.contact.update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { email: 'ana@example.com', company: null },
    });
  });

  it('does not sync anything when nothing changed', async () => {
    const { service, realtime } = build([
      {
        id: 'c1',
        name: 'Ana',
        email: null,
        company: null,
        phones: [{ e164: '+14155550100', label: null }],
      },
    ]);
    const result = await service.import(actor, {
      source: 'device',
      contacts: [{ name: 'Ana', phones: [{ number: '4155550100' }] }],
    });
    expect(result).toEqual({ created: 0, updated: 0, skipped: 1 });
    expect(realtime.voiceAppSync).not.toHaveBeenCalled();
  });
});
