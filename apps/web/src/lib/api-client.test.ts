import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from './api-client';

describe('api-client request', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null for a 200 response with an empty body', async () => {
    // NestJS serialises a handler's `null` (e.g. no previous dial) as an empty 200.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 200 })));

    await expect(api.calls.lastDial('pn1', '+15551111111')).resolves.toBeNull();
  });

  it('parses a JSON body', async () => {
    const lastDial = {
      callId: 'c1',
      destinationNumber: '+15551111111',
      lastDialedAt: '2026-09-11T19:00:00.000Z',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(lastDial), { status: 200 })),
    );

    await expect(api.calls.lastDial('pn1', '+15551111111')).resolves.toEqual(lastDial);
  });
});
