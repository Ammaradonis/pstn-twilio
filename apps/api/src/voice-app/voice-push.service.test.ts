import { describe, expect, it, vi } from 'vitest';
import webpush from 'web-push';

import { VoicePushService } from './voice-push.service';

// Hoisted above the imports by Vitest.
vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn() },
}));

function build(
  env: Record<string, string | undefined>,
  devices: Array<Record<string, unknown>> = [],
) {
  const config = {
    get: (key: string) => env[key],
    getOrThrow: (key: string) => {
      if (!env[key]) throw new Error(`${key} missing`);
      return env[key];
    },
  };
  const prisma = {
    userDevice: {
      findMany: vi.fn().mockResolvedValue(devices),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  return { service: new VoicePushService(config as never, prisma as never), prisma };
}

const KEYS = { VAPID_PUBLIC_KEY: 'pub', VAPID_PRIVATE_KEY: 'priv', JWT_SECRET: 'secret' };
const payload = {
  type: 'message' as const,
  title: 'Ana',
  body: 'Hi',
  tag: 'sms-x',
  url: '/voice/messages',
};

describe('VoicePushService', () => {
  it('is off without VAPID keys and sends nothing', async () => {
    const { service, prisma } = build({ JWT_SECRET: 'secret' });
    expect(service.publicKey).toBeNull();
    await service.sendToUser('u1', payload, { ttl: 60, urgency: 'high' });
    expect(prisma.userDevice.findMany).not.toHaveBeenCalled();
  });

  it('drops subscriptions the push service says are gone', async () => {
    const { service, prisma } = build(KEYS, [
      { id: 'd1', pushEndpoint: 'https://push/1', pushP256dh: 'k', pushAuth: 'a' },
      { id: 'd2', pushEndpoint: 'https://push/2', pushP256dh: 'k', pushAuth: 'a' },
    ]);
    vi.mocked(webpush.sendNotification)
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }))
      .mockResolvedValueOnce({} as never);
    await service.sendToUser('u1', payload, { ttl: 60, urgency: 'high' });
    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    expect(prisma.userDevice.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: { pushEndpoint: null, pushP256dh: null, pushAuth: null },
    });
  });

  it('accepts its own action tokens until they expire', () => {
    const { service } = build(KEYS);
    const now = Date.now();
    const token = service.actionToken('user-1', 'CA123', now);
    expect(service.verifyActionToken(token, now + 1000)).toEqual({
      userId: 'user-1',
      callSid: 'CA123',
    });
    expect(service.verifyActionToken(token, now + 3 * 60_000)).toBeNull();
    expect(service.verifyActionToken(token.replace('CA123', 'CA999'), now)).toBeNull();
  });
});
