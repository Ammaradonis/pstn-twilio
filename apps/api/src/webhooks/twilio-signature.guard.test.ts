import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { TwilioSignatureGuard } from './twilio-signature.guard';

function buildContext(req: {
  body?: Record<string, unknown>;
  originalUrl?: string;
  header?: (name: string) => string | undefined;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  } as unknown as ExecutionContext;
}

describe('TwilioSignatureGuard', () => {
  it('returns true when TwilioService.validateSignature passes', () => {
    const twilio = {
      webhookBaseUrl: 'https://example.com',
      validateSignature: vi.fn().mockReturnValue(true),
    } as never;
    const guard = new TwilioSignatureGuard(twilio);
    const result = guard.canActivate(
      buildContext({
        body: { MessageSid: 'SM1' },
        originalUrl: '/webhooks/twilio/messaging/inbound',
        header: (name) => (name.toLowerCase() === 'x-twilio-signature' ? 'sig' : undefined),
      }),
    );
    expect(result).toBe(true);
    expect((twilio as { validateSignature: any }).validateSignature).toHaveBeenCalledWith(
      'sig',
      'https://example.com/webhooks/twilio/messaging/inbound',
      { MessageSid: 'SM1' },
    );
  });

  it('returns false when validateSignature fails', () => {
    const twilio = {
      webhookBaseUrl: 'https://example.com',
      validateSignature: vi.fn().mockReturnValue(false),
    } as never;
    const guard = new TwilioSignatureGuard(twilio);
    const result = guard.canActivate(
      buildContext({
        body: {},
        originalUrl: '/webhooks/twilio/messaging/inbound',
        header: () => undefined,
      }),
    );
    expect(result).toBe(false);
  });
});
