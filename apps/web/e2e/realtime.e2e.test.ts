import { expect, ownerUser, test } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.addInitScript((user) => {
    localStorage.setItem('pstn-twilio.token', 'fake-jwt');
    localStorage.setItem(
      'pstn-twilio.auth',
      JSON.stringify({ state: { token: 'fake-jwt', user }, version: 0 }),
    );
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        // A failed handshake, rather than a server closing an open connection.
        super(String(url).includes('/socket.io/') ? 'ws://127.0.0.1:1/socket.io/' : url, protocols);
      }
    };
  }, ownerUser);
});

test('connects through polling when WebSockets are blocked', async ({ page }) => {
  let receivedToken: string | undefined;
  let connected = false;
  let authenticate!: () => void;
  const authenticated = new Promise<void>((resolve) => {
    authenticate = resolve;
  });
  await page.route(/\/socket\.io\/?.*/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const reply = (body: string) => route.fulfill({ status: 200, contentType: 'text/plain', body });
    if (!url.searchParams.has('sid')) {
      return reply(
        '0' +
          JSON.stringify({
            sid: 'polling-session',
            upgrades: [],
            pingInterval: 25000,
            pingTimeout: 20000,
            maxPayload: 1000000,
          }),
      );
    }
    if (request.method() === 'POST') {
      const packet = request.postData() ?? '';
      if (packet.startsWith('40')) {
        receivedToken = JSON.parse(packet.slice(2)).token;
        authenticate();
      }
      return reply('ok');
    }
    await authenticated;
    if (!connected) {
      connected = true;
      return reply('40{"sid":"authenticated-socket"}');
    }
    // Leave the next long poll pending, as a server awaiting an event would.
  });

  await page.goto('/dashboard');
  await expect(page.getByTitle('Realtime: ok')).toBeVisible({ timeout: 12000 });
  expect(receivedToken).toBe('fake-jwt');
});

test('reports down when both WebSockets and polling are unavailable', async ({ page }) => {
  await page.route(/\/socket\.io\/?.*/, (route) => route.abort('connectionrefused'));
  await page.goto('/dashboard');
  await expect(page.getByTitle('Realtime: down')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTitle('Realtime: ok')).toHaveCount(0);
});
