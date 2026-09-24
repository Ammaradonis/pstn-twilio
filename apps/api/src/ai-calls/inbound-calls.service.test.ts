import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { VoiceWebhookController } from '../webhooks/voice.controller';

import { InboundCallsService, VAPI_TWILIO_INBOUND_URL } from './inbound-calls.service';

const REJECT_URL = 'https://api.example.com/webhooks/twilio/voice/reject';

function build(voiceUrl: string, callerNumber: string | null = '+16672206726') {
  const update = vi.fn(async ({ voiceUrl: next }: { voiceUrl: string }) => ({
    phoneNumber: '+16672206726',
    voiceUrl: next,
  }));
  const list = vi.fn().mockResolvedValue([{ sid: 'PN667', phoneNumber: '+16672206726', voiceUrl }]);
  const numberResource = Object.assign(
    vi.fn(() => ({ update })),
    { list },
  );
  const accounts = vi.fn(() => ({ incomingPhoneNumbers: numberResource }));
  const twilio = { accountSid: 'AC1', client: { api: { v2010: { accounts } } } };
  const settings = { callerNumber, publicApiBaseUrl: 'https://api.example.com' };
  const audit = { log: vi.fn().mockResolvedValue(undefined) };
  const service = new InboundCallsService(twilio as never, settings as never, audit as never);
  return { service, update, list, numberResource, accounts, audit };
}

describe('InboundCallsService', () => {
  it('reports whether incoming calls are blocked, answered by the agent, or routed elsewhere', async () => {
    await expect(build(REJECT_URL).service.status()).resolves.toEqual({
      phoneNumber: '+16672206726',
      mode: 'blocked',
    });
    await expect(build(VAPI_TWILIO_INBOUND_URL).service.status()).resolves.toMatchObject({
      mode: 'agent',
    });
    await expect(build('https://elsewhere.example/voice').service.status()).resolves.toMatchObject({
      mode: 'other',
    });
  });

  it('blocks by pointing the 667 Voice URL at the busy-signal webhook', async () => {
    const { service, update, list, numberResource, accounts, audit } =
      build(VAPI_TWILIO_INBOUND_URL);

    await expect(service.setMode({ userId: 'u1' }, 'blocked')).resolves.toEqual({
      phoneNumber: '+16672206726',
      mode: 'blocked',
    });

    expect(accounts).toHaveBeenCalledWith('AC1');
    expect(list).toHaveBeenCalledWith({ phoneNumber: '+16672206726', limit: 1 });
    expect(numberResource).toHaveBeenCalledWith('PN667');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceUrl: REJECT_URL,
        voiceMethod: 'POST',
        voiceApplicationSid: '',
        voiceFallbackUrl: REJECT_URL,
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ai_inbound.blocked',
        metadata: expect.objectContaining({
          previous: 'agent',
          previousVoiceUrl: VAPI_TWILIO_INBOUND_URL,
        }),
      }),
    );
  });

  it('rings the browser without enabling automatic answering', async () => {
    const { service, update, audit } = build(REJECT_URL);

    await expect(service.setMode({ userId: 'u1' }, 'browser')).resolves.toMatchObject({
      mode: 'browser',
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceUrl: 'https://api.example.com/webhooks/twilio/voice/inbound',
        voiceMethod: 'POST',
      }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'ai_inbound.browser_enabled' }),
    );
  });

  it('rejects stale clients trying to re-enable the agent', async () => {
    const { service, update } = build(REJECT_URL);
    await expect(service.setMode({ userId: 'u1' }, 'agent' as never)).rejects.toThrow(
      'answered manually',
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('explains a missing number or a Twilio failure', async () => {
    const noNumber = build(REJECT_URL, null);
    await expect(noNumber.service.status()).rejects.toBeInstanceOf(NotFoundException);

    const notOnAccount = build(REJECT_URL);
    notOnAccount.list.mockResolvedValue([]);
    await expect(notOnAccount.service.status()).rejects.toThrow('is not on the Twilio account');

    const failing = build(VAPI_TWILIO_INBOUND_URL);
    failing.update.mockRejectedValue(new Error('Authenticate'));
    await expect(failing.service.setMode({ userId: 'u1' }, 'blocked')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(failing.audit.log).not.toHaveBeenCalled();
  });
});

describe('VoiceWebhookController.reject', () => {
  it('answers with a busy signal without picking up', () => {
    const controller = new VoiceWebhookController({} as never);
    expect(controller.reject()).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Reject reason="busy"/></Response>',
    );
  });
});
