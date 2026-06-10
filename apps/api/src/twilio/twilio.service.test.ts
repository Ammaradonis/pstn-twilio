import { describe, expect, it, vi, beforeEach } from 'vitest';

import { TwilioService } from './twilio.service';

const twilioMocks = vi.hoisted(() => ({
  accountFetch: vi.fn(),
  incomingPhoneNumbersList: vi.fn(),
  applicationFetch: vi.fn(),
  applicationUpdate: vi.fn(),
  validateRequest: vi.fn(),
}));

vi.mock('twilio', () => {
  const client = {
    api: {
      v2010: {
        accounts: vi.fn(() => ({
          fetch: twilioMocks.accountFetch,
          incomingPhoneNumbers: {
            list: twilioMocks.incomingPhoneNumbersList,
          },
        })),
      },
    },
    applications: vi.fn(() => ({
      fetch: twilioMocks.applicationFetch,
      update: twilioMocks.applicationUpdate,
    })),
  };

  const twilio = vi.fn(() => client);
  return {
    default: twilio,
    validateRequest: twilioMocks.validateRequest,
  };
});

function buildService() {
  const configValues: Record<string, string> = {
    TWILIO_ACCOUNT_SID: 'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    TWILIO_AUTH_TOKEN: 'auth-token',
    TWILIO_API_KEY_SID: 'SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    TWILIO_API_KEY_SECRET: 'api-secret',
    TWILIO_TWIML_APP_SID: 'APxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    TWILIO_WEBHOOK_BASE_URL: 'https://api.example.com',
  };
  return new TwilioService({
    get: vi.fn((key: string) => configValues[key]),
  } as never);
}

describe('TwilioService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    twilioMocks.accountFetch.mockResolvedValue({ status: 'active' });
    twilioMocks.incomingPhoneNumbersList.mockResolvedValue([]);
    twilioMocks.applicationFetch.mockResolvedValue({
      voiceUrl: 'https://api.example.com/webhooks/twilio/voice/outbound',
      voiceMethod: 'POST',
    });
    twilioMocks.applicationUpdate.mockResolvedValue({});
  });

  it('exposes the outbound TwiML App URL separately from inbound number URLs', () => {
    const service = buildService();

    expect(service.defaultWebhookUrls()).toEqual(
      expect.objectContaining({
        outboundVoiceUrl: 'https://api.example.com/webhooks/twilio/voice/outbound',
        outboundVoiceFallbackUrl: 'https://api.example.com/webhooks/twilio/voice/fallback',
        voiceUrl: 'https://api.example.com/webhooks/twilio/voice/inbound',
      }),
    );
  });

  it('derives the messaging status callback URL from the webhook base by default', () => {
    const service = buildService();

    expect(service.messagingStatusCallbackUrl).toBe(
      'https://api.example.com/webhooks/twilio/messaging/status',
    );
  });

  it('fails validation when the TwiML App Voice URL points away from outbound', async () => {
    twilioMocks.applicationFetch.mockResolvedValue({
      voiceUrl: 'https://api.example.com/webhooks/twilio/voice/inbound',
      voiceMethod: 'POST',
    });
    const service = buildService();

    await expect(service.validateCredentials()).resolves.toBe(false);
  });

  it('configures the TwiML App for browser-originated outbound calls', async () => {
    const service = buildService();

    await service.configureTwimlApplication();

    expect(twilioMocks.applicationUpdate).toHaveBeenCalledWith({
      voiceUrl: 'https://api.example.com/webhooks/twilio/voice/outbound',
      voiceMethod: 'POST',
      voiceFallbackUrl: 'https://api.example.com/webhooks/twilio/voice/fallback',
      voiceFallbackMethod: 'POST',
      statusCallback: 'https://api.example.com/webhooks/twilio/voice/status',
      statusCallbackMethod: 'POST',
    });
  });
});
