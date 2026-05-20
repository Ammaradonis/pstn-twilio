/**
 * Round-trip test for the Twilio signature flow:
 *
 *   - we sign a payload exactly the way Twilio does (HMAC-SHA1 over
 *     `url + concat(sorted(key+value))`, base64),
 *   - we feed that signature into the real `TwilioService.validateSignature`
 *     (which delegates to the official `twilio.validateRequest` helper),
 *   - and we run the guard end-to-end against a synthetic ExecutionContext.
 *
 * This proves that the guard accepts requests Twilio would actually send and
 * rejects any tampering — without spinning up a NestJS HTTP server (the
 * vitest transformer doesn't emit decorator metadata so a full Nest e2e is
 * not viable).
 */
import * as crypto from 'node:crypto';

import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';

import { TwilioService } from '../twilio/twilio.service';

import { TwilioSignatureGuard } from './twilio-signature.guard';

const AUTH_TOKEN = 'unit-test-auth-token';
const WEBHOOK_BASE_URL = 'https://example.test';

function makeConfig(map: Record<string, string>): ConfigService {
  return {
    get: (key: string) => map[key],
  } as unknown as ConfigService;
}

function makeTwilioService(): TwilioService {
  return new TwilioService(
    makeConfig({
      TWILIO_ACCOUNT_SID: 'ACtest',
      TWILIO_AUTH_TOKEN: AUTH_TOKEN,
      TWILIO_WEBHOOK_BASE_URL: WEBHOOK_BASE_URL,
    }),
  );
}

function signTwilio(url: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  const data = url + sortedKeys.map((k) => `${k}${params[k]}`).join('');
  return crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
}

function buildContext(req: {
  body?: Record<string, unknown>;
  originalUrl?: string;
  signature?: string;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        body: req.body ?? {},
        originalUrl: req.originalUrl ?? '/',
        header: (name: string) =>
          name.toLowerCase() === 'x-twilio-signature' ? req.signature : undefined,
      }),
    }),
  } as unknown as ExecutionContext;
}

describe('Twilio signature round-trip (real HMAC + real validateRequest)', () => {
  const twilio = makeTwilioService();
  const guard = new TwilioSignatureGuard(twilio);

  const path = '/webhooks/twilio/messaging/inbound';
  const params = {
    MessageSid: 'SM12345',
    From: '+15551111111',
    To: '+15552222222',
    Body: 'hello world',
  };
  const fullUrl = `${WEBHOOK_BASE_URL}${path}`;

  it('accepts a request signed for the exact URL + params', () => {
    const signature = signTwilio(fullUrl, params);
    expect(twilio.validateSignature(signature, fullUrl, params)).toBe(true);

    const allowed = guard.canActivate(buildContext({ body: params, originalUrl: path, signature }));
    expect(allowed).toBe(true);
  });

  it('rejects a request where the signature was computed for a different URL', () => {
    const signature = signTwilio(`${WEBHOOK_BASE_URL}/some/other/path`, params);
    expect(twilio.validateSignature(signature, fullUrl, params)).toBe(false);

    const allowed = guard.canActivate(buildContext({ body: params, originalUrl: path, signature }));
    expect(allowed).toBe(false);
  });

  it('rejects a request where the body has been tampered with', () => {
    const signature = signTwilio(fullUrl, params);
    const tampered = { ...params, Body: 'spoofed message' };
    expect(twilio.validateSignature(signature, fullUrl, tampered)).toBe(false);

    const allowed = guard.canActivate(
      buildContext({ body: tampered, originalUrl: path, signature }),
    );
    expect(allowed).toBe(false);
  });

  it('rejects a request with an entirely missing signature header', () => {
    const allowed = guard.canActivate(
      buildContext({ body: params, originalUrl: path, signature: undefined }),
    );
    expect(allowed).toBe(false);
  });

  it('rejects a request signed with a different auth token', () => {
    const record: Record<string, string> = params;
    const sortedKeys = Object.keys(record).sort();
    const data = fullUrl + sortedKeys.map((k) => `${k}${record[k]}`).join('');
    const signature = crypto.createHmac('sha1', 'attacker-token').update(data).digest('base64');
    expect(twilio.validateSignature(signature, fullUrl, params)).toBe(false);

    const allowed = guard.canActivate(buildContext({ body: params, originalUrl: path, signature }));
    expect(allowed).toBe(false);
  });
});
