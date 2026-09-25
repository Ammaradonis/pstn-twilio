import { expect, test, type Page } from '@playwright/test';

import { ownerUser, sampleNumber } from './fixtures';

// Exercise the built UI and real browser clipboard/media permissions without
// contacting Twilio. Set E2E_BROWSER_CHANNEL=chrome to use installed Chrome.
test.use({
  channel: process.env.E2E_BROWSER_CHANNEL || undefined,
  viewport: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
  permissions: ['microphone', 'clipboard-read', 'clipboard-write'],
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

type CallRequest = {
  selectedNumberId: string;
  destinationNumber: string;
  recordCall: boolean;
};

type Harness = {
  device: { emit: (event: string, value?: unknown) => void };
  devices: number;
  calls: Array<{ emit: (event: string, value?: unknown) => void; accepted: boolean }>;
  connectOptions: Array<{ params: Record<string, string> }>;
  inputs: string[];
  releases: number;
  registrations: number;
  incoming: () => void;
};

declare global {
  interface Window {
    __voiceHarness: Harness;
    __voiceStalled?: boolean;
  }
}

const fakeSdk = String.raw`
class Emitter {
  handlers = new Map();
  on(event, fn) {
    this.handlers.set(event, [...(this.handlers.get(event) || []), fn]);
    return this;
  }
  emit(event, value) {
    for (const fn of this.handlers.get(event) || []) fn(value);
  }
}
class Call extends Emitter {
  parameters = { From: '+442079460018' };
  accepted = false;
  muted = false;
  isMuted() { return this.muted; }
  mute(value) { this.muted = value; this.emit('mute', value); }
  status() { return this.accepted ? 'open' : 'pending'; }
  sendDigits() {}
  accept() { this.accepted = true; this.emit('accept'); }
  reject() { this.emit('reject'); }
  disconnect() { this.emit('disconnect'); }
}
export class Device extends Emitter {
  state = 'unregistered';
  constructor() {
    super();
    const h = window.__voiceHarness ||= {
      calls: [], connectOptions: [], inputs: [], releases: 0, registrations: 0, devices: 0,
    };
    h.device = this;
    h.devices++;
    h.incoming = () => {
        const call = new Call();
        h.calls.push(call);
        this.emit('incoming', call);
    };
    this.audio = {
      on() {},
      setAudioConstraints: async () => {},
      setInputDevice: async (id) => { h.inputs.push(id); },
      unsetInputDevice: async () => { h.releases++; },
    };
  }
  async register() {
    window.__voiceHarness.registrations++;
    this.state = 'registering';
    this.emit('registering');
    if (window.__voiceStalled) await new Promise(() => {});
    this.state = 'registered';
    this.emit('registered');
  }
  updateToken() {}
  destroy() { this.state = 'destroyed'; }
  disconnectAll() {}
  async connect(options) {
    const call = new Call();
    window.__voiceHarness.calls.push(call);
    window.__voiceHarness.connectOptions.push(options);
    return call;
  }
}
`;

async function installSoftphoneMocks(page: Page) {
  const state = {
    prepared: [] as CallRequest[],
    recordingWrites: [] as boolean[],
    recordCall: false,
    repeatLookups: 0,
    pageErrors: [] as string[],
    outcomeStatus: null as string | null,
  };
  const number = { ...sampleNumber, country: 'GB', phoneNumberE164: '+447458904436' };
  page.on('pageerror', (error) => state.pageErrors.push(error.message));
  await page.addInitScript((user) => {
    localStorage.setItem(
      'pstn-twilio.auth',
      JSON.stringify({ state: { token: 'fake-jwt', user }, version: 0 }),
    );
    localStorage.setItem('pstn-twilio.record-calls', 'false');
  }, ownerUser);
  await page.routeWebSocket('**/*', (socket) => socket.close());
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (/\/assets\/twilio-[^/]+\.js$/.test(path)) {
      return route.fulfill({ contentType: 'text/javascript', body: fakeSdk });
    }
    if (!path.startsWith('/api/')) {
      // Fail closed: even a production-configured build cannot reach external
      // HTTP services, and the fake SDK cannot establish real call signaling.
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
        return route.continue();
      }
      return route.abort();
    }
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (route.request().method() === 'OPTIONS') return json({});
    if (path === '/api/auth/me') return json(ownerUser);
    if (path === '/api/numbers') return json([number]);
    if (path === '/api/numbers/n1') return json(number);
    if (path === '/api/voice/device-config') return json({ codecPreferences: ['opus', 'pcmu'] });
    if (path === '/api/voice/token') {
      return json({
        token: 'fake-voice-jwt',
        identity: 'user_u1_number_n1',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    if (path === '/api/calls/prepare-outbound') {
      const body = route.request().postDataJSON() as CallRequest;
      state.prepared.push(body);
      return json({
        ...body,
        outboundIntentId: `intent${state.prepared.length}`,
        selectedCallerId: number.phoneNumberE164,
        identity: 'user_u1_number_n1',
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
    }
    if (path === '/api/numbers/n1/last-dial') {
      state.repeatLookups++;
      return json(null);
    }
    if (/\/outbound-intents\/[^/]+\/call$/.test(path)) {
      return json(state.outcomeStatus ? { status: state.outcomeStatus } : null);
    }
    if (path === '/api/voice/numbers/n1/recording-preference') {
      if (route.request().method() === 'PUT') {
        state.recordCall = route.request().postDataJSON().recordCall;
        state.recordingWrites.push(state.recordCall);
      }
      return json({ numberId: 'n1', recordCall: state.recordCall });
    }
    return json({ message: 'Not needed by this browser test' }, 404);
  });
  return state;
}

async function openSoftphone(page: Page, tab: 'dial' | 'answer') {
  await page.goto(`/numbers/n1/${tab}`);
  await expect(page.getByText('Registered', { exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Microphone choice' })).toBeVisible();
}

async function pasteAndCall(page: Page, text: string) {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
}

test('UK clipboard dialing and 31603 recovery work in mobile Chrome layout', async ({ page }) => {
  const state = await installSoftphoneMocks(page);
  await openSoftphone(page, 'dial');
  await pasteAndCall(page, 'Contact our London office: +44 (0)20 7946 0018');
  await expect(page.getByRole('button', { name: 'In call', exact: true })).toBeVisible();
  await expect(page.getByLabel('Destination (E.164)')).toHaveValue('+442079460018');
  expect(state.prepared).toEqual([
    { selectedNumberId: 'n1', destinationNumber: '+442079460018', recordCall: false },
  ]);
  expect(state.repeatLookups).toBe(0);
  expect(await page.evaluate(() => window.__voiceHarness.connectOptions[0].params)).toEqual({
    selectedNumberId: 'n1',
    destinationNumber: '+442079460018',
    outboundIntentId: 'intent1',
  });

  await page.evaluate(() => window.__voiceHarness.calls[0].emit('error', { code: 31603 }));
  await expect(page.getByRole('status')).toContainText('Call declined');
  await expect(page.getByRole('button', { name: 'Hangup', exact: true })).toBeDisabled();
  await expect(page.getByText('Registered', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__voiceHarness.releases)).toBeGreaterThan(0);

  await pasteAndCall(page, '0044 161 496 0123');
  await expect(page.getByRole('button', { name: 'In call', exact: true })).toBeVisible();
  expect(state.prepared[1].destinationNumber).toBe('+441614960123');
  await page.evaluate(() => window.__voiceHarness.calls[0].emit('disconnect'));
  await expect(page.getByRole('button', { name: 'Hangup', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__voiceHarness.registrations)).toBe(1);
  await page.getByRole('button', { name: 'Hangup', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Hangup', exact: true })).toBeDisabled();
  expect(state.pageErrors).toEqual([]);
});

test('ambiguous UK clipboard content does not call; direct field paste calls once', async ({
  page,
}) => {
  const state = await installSoftphoneMocks(page);
  await openSoftphone(page, 'dial');
  await page.getByLabel('Destination (E.164)').fill('020');
  await expect(
    page.getByText('Enter a UK number such as 020 7946 0018 or 0161 496 0123.'),
  ).toBeVisible();
  await pasteAndCall(page, 'London: 020 7946 0018; Manchester: 0161 496 0123');
  await expect(page.getByText('Copy one complete UK phone number', { exact: false })).toBeVisible();
  expect(state.prepared).toEqual([]);
  await page.getByLabel('Destination (E.164)').evaluate((input) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '020 7946 0018');
    for (let i = 0; i < 2; i++) {
      input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true }));
    }
  });
  await expect(page.getByRole('button', { name: 'In call', exact: true })).toBeVisible();
  expect(state.prepared).toHaveLength(1);
  expect(state.prepared[0].destinationNumber).toBe('+442079460018');
  expect(state.repeatLookups).toBe(0);
  expect(state.pageErrors).toEqual([]);
});

test('a gateway HANGUP wrapper shows the confirmed no-answer outcome without reconnecting', async ({
  page,
}) => {
  const state = await installSoftphoneMocks(page);
  await openSoftphone(page, 'dial');
  await pasteAndCall(page, '020 7946 0018');
  await expect(page.getByRole('button', { name: 'In call', exact: true })).toBeVisible();
  state.outcomeStatus = 'NO_ANSWER';
  await page.evaluate(() =>
    window.__voiceHarness.calls[0].emit(
      'error',
      Object.assign(new Error('Error sent from gateway in HANGUP'), {
        code: 31005,
        originalError: { code: 31000, message: 'Call ended' },
      }),
    ),
  );
  await expect(page.getByRole('status')).toContainText('No answer');
  await expect(page.getByText('Registered', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect voice' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Paste', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => window.__voiceHarness.devices)).toBe(1);
  expect(state.pageErrors).toEqual([]);
});

test('Chrome stops a sustained reconnect loop and the manual retry restores readiness', async ({
  page,
}) => {
  const state = await installSoftphoneMocks(page);
  await openSoftphone(page, 'dial');
  await page.clock.install();
  await page.evaluate(() => {
    window.__voiceStalled = true;
    window.__voiceHarness.device.emit('error', { code: 31009, message: 'Transport unavailable' });
  });
  await expect(page.getByRole('status')).toContainText('Restoring the voice connection');
  await expect(page.getByRole('button', { name: 'Paste', exact: true })).toBeDisabled();
  await page.clock.runFor(8_000);
  await expect.poll(() => page.evaluate(() => window.__voiceHarness.devices)).toBe(2);
  await page.clock.runFor(22_000);
  await expect(page.getByRole('status')).toContainText('Voice connection unavailable');
  await expect(page.getByText('Reconnecting…', { exact: true })).toHaveCount(0);
  const attempts = await page.evaluate(() => window.__voiceHarness.devices);
  await page.clock.runFor(120_000);
  expect(await page.evaluate(() => window.__voiceHarness.devices)).toBe(attempts);
  await page.evaluate(() => {
    window.__voiceStalled = false;
  });
  await page.getByRole('button', { name: 'Reconnect voice', exact: true }).click();
  await expect(page.getByText('Registered', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Paste', exact: true })).toBeEnabled();
  expect(state.prepared).toEqual([]);
  expect(state.pageErrors).toEqual([]);
});

test('Answer requires a click, recording is opt-in, and microphones switch during a call', async ({
  page,
}) => {
  const state = await installSoftphoneMocks(page);
  await openSoftphone(page, 'answer');
  const recording = page.getByRole('switch', { name: 'Record call', exact: true });
  await expect(recording).toBeEnabled();
  await expect(recording).toHaveAttribute('aria-checked', 'false');
  expect(state.recordingWrites).toEqual([]);
  await recording.click();
  await expect(recording).toHaveAttribute('aria-checked', 'true');
  await recording.click();
  await expect(recording).toHaveAttribute('aria-checked', 'false');
  expect(state.recordingWrites).toEqual([true, false]);

  await page.getByRole('button', { name: 'Refresh microphones', exact: true }).click();
  const microphones = page.getByRole('group', { name: 'Microphone choice' });
  const explicitMic = microphones
    .getByRole('button')
    .filter({ hasNotText: /Automatic|Refresh microphones/ })
    .first();
  await explicitMic.click();
  await expect(explicitMic).toHaveAttribute('aria-pressed', 'true');

  await page.evaluate(() => window.__voiceHarness.incoming());
  await expect(page.getByRole('button', { name: 'Answer', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__voiceHarness.calls[0].accepted)).toBe(false);
  await expect(recording).toBeDisabled();
  await page.getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Live call', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__voiceHarness.inputs.length)).toBe(1);
  const releases = await page.evaluate(() => window.__voiceHarness.releases);
  await microphones.getByRole('button', { name: 'Automatic', exact: true }).click();
  await expect(microphones.getByRole('button', { name: 'Automatic' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await page.evaluate(() => window.__voiceHarness.inputs.at(-1))).toBe('default');
  expect(await page.evaluate(() => window.__voiceHarness.releases)).toBe(releases);
  await page.getByRole('button', { name: 'Hangup', exact: true }).click();
  await expect(recording).toBeEnabled();
  expect(await page.evaluate(() => window.__voiceHarness.releases)).toBeGreaterThan(releases);
  expect(state.recordingWrites).toEqual([true, false]);
  expect(state.pageErrors).toEqual([]);
});
