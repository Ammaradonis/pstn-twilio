/**
 * Shared Playwright fixtures: typed API mocks for the Phase 10 E2E suite.
 *
 * Every test runs against `pnpm preview` (production-built Vite bundle) but
 * intercepts every `/api/*` request with `page.route()` so the suite is
 * hermetic — no Twilio, no Postgres, no Redis required.
 */
import { test as base, expect, type Page, type Route } from '@playwright/test';

export interface MockState {
  numbers: Array<Record<string, unknown>>;
  messagesByNumberId: Record<string, Array<Record<string, unknown>>>;
  callsByNumberId: Record<string, Array<Record<string, unknown>>>;
  voiceTokenCount: number;
}

export const ownerUser = {
  id: 'u1',
  email: 'owner@example.com',
  role: 'OWNER',
  createdAt: new Date('2024-01-01T00:00:00Z').toISOString(),
  lastLoginAt: null,
};

export const sampleNumber = {
  id: 'n1',
  userId: 'u1',
  twilioAccountSid: 'ACtest',
  twilioIncomingPhoneNumberSid: 'PNtest',
  phoneNumberE164: '+15551234567',
  friendlyName: 'Demo Number',
  country: 'US',
  areaCode: '555',
  numberType: 'local',
  capabilitiesVoice: true,
  capabilitiesSms: true,
  capabilitiesMms: false,
  whatsappCompatibilityStatus: 'NOT_GUARANTEED',
  voiceWebhookUrl: 'https://example.test/webhooks/twilio/voice/inbound',
  smsWebhookUrl: 'https://example.test/webhooks/twilio/messaging/inbound',
  statusCallbackUrl: 'https://example.test/webhooks/twilio/voice/status',
  active: true,
  tags: {},
  purchasedAt: new Date('2024-01-02T00:00:00Z').toISOString(),
  releasedAt: null,
};

function defaultState(): MockState {
  return {
    numbers: [JSON.parse(JSON.stringify(sampleNumber))],
    messagesByNumberId: {
      n1: [
        {
          id: 'm1',
          phoneNumberId: 'n1',
          direction: 'INBOUND',
          status: 'RECEIVED',
          from: '+15558675309',
          to: '+15551234567',
          body: 'hi from the past',
          providerMessageSid: 'SM1',
          numSegments: 1,
          errorCode: null,
          errorMessage: null,
          createdAt: new Date('2024-01-03T00:00:00Z').toISOString(),
          updatedAt: new Date('2024-01-03T00:00:00Z').toISOString(),
        },
      ],
    },
    callsByNumberId: { n1: [] },
    voiceTokenCount: 0,
  };
}

export async function installApiMocks(page: Page, state: MockState): Promise<void> {
  // health endpoints
  for (const sub of ['', '/db', '/redis', '/twilio']) {
    await page.route(`**/api/health${sub}`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          status: 'ok',
          checks: {},
          uptimeSeconds: 1,
          timestamp: new Date().toISOString(),
        }),
      }),
    );
  }

  // auth: login + me + logout + change-password
  await page.route('**/api/auth/login', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const body = JSON.parse(route.request().postData() ?? '{}');
    if (body.email === 'owner@example.com' && body.password === 'correct-horse') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'fake-jwt', user: ownerUser }),
      });
    }
    return route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Invalid email or password' }),
    });
  });

  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(ownerUser),
    }),
  );

  await page.route('**/api/auth/logout', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'ok' }),
    }),
  );

  await page.route('**/api/auth/change-password', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Password updated' }),
    }),
  );

  // numbers: list / get
  await page.route('**/api/numbers', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(state.numbers),
      });
    }
    return route.continue();
  });

  await page.route(/\/api\/numbers\/[^/?]+$/, async (route) => {
    const id = route.request().url().split('/api/numbers/')[1].split('?')[0];
    const number = state.numbers.find((n) => (n as { id: string }).id === id);
    if (!number) {
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'not found' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(number),
    });
  });

  // messages list + send + global search
  await page.route(/\/api\/numbers\/[^/]+\/messages(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const numberId = url.pathname.split('/')[3];
    const items = state.messagesByNumberId[numberId] ?? [];
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items, total: items.length }),
      });
    }
    if (route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}');
      const message = {
        id: `m${items.length + 1}`,
        phoneNumberId: numberId,
        direction: 'OUTBOUND',
        status: 'QUEUED',
        from: (state.numbers[0] as { phoneNumberE164: string }).phoneNumberE164,
        to: body.to,
        body: body.body,
        providerMessageSid: `SM${items.length + 1}`,
        numSegments: 1,
        errorCode: null,
        errorMessage: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.messagesByNumberId[numberId] = [message, ...items];
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify(message),
      });
    }
    return route.continue();
  });

  await page.route('**/api/messages/search**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(Object.values(state.messagesByNumberId).flat().slice(0, 5)),
    }),
  );

  // calls list per number
  await page.route(/\/api\/numbers\/[^/]+\/calls(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    const numberId = url.pathname.split('/')[3];
    const items = state.callsByNumberId[numberId] ?? [];
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items, total: items.length }),
    });
  });

  // voice token + identity
  await page.route('**/api/voice/token**', (route) => {
    state.voiceTokenCount += 1;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        token: 'fake-voice-jwt',
        identity: 'user_u1_number_n1',
        ttl: 3600,
      }),
    });
  });

  await page.route('**/api/voice/identity**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ identity: 'user_u1_number_n1' }),
    }),
  );

  // socket.io polling endpoint (when websocket can't open) — keep the suite
  // from spamming the server with retries
  await page.route(/\/socket\.io\/?.*/, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body: '0{"sid":"fake","upgrades":[],"pingInterval":25000,"pingTimeout":20000}',
    }),
  );
}

export const test = base.extend<{ state: MockState }>({
  state: async ({ page }, runFixture) => {
    const state = defaultState();
    await installApiMocks(page, state);
    await runFixture(state);
  },
});

export { expect };
