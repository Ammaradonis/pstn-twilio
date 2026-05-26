import { describe, expect, it } from 'vitest';

import {
  e164Schema,
  isoCountrySchema,
  numberSearchSchema,
  prepareOutboundCallSchema,
  purchaseNumberSchema,
  sendMessageSchema,
} from './index';

describe('e164Schema', () => {
  it.each(['+14155552671', '+447911123456', '+819012345678'])('accepts %s', (n) => {
    expect(e164Schema.safeParse(n).success).toBe(true);
  });

  it.each(['', '14155552671', '+0123', '+1-415-555-2671', '++1', '+1' + '2'.repeat(15)])(
    'rejects %s',
    (n) => {
      expect(e164Schema.safeParse(n).success).toBe(false);
    },
  );
});

describe('isoCountrySchema', () => {
  it('accepts US, GB, AU', () => {
    expect(isoCountrySchema.safeParse('US').success).toBe(true);
    expect(isoCountrySchema.safeParse('GB').success).toBe(true);
  });
  it('rejects lowercase and 3-letter codes', () => {
    expect(isoCountrySchema.safeParse('us').success).toBe(false);
    expect(isoCountrySchema.safeParse('USA').success).toBe(false);
  });
});

describe('numberSearchSchema', () => {
  it('parses a minimal search', () => {
    const parsed = numberSearchSchema.parse({ country: 'US' });
    expect(parsed.type).toBe('local');
    expect(parsed.excludeAddressRequired).toBe(true);
    expect(parsed.pageSize).toBe(20);
  });

  it('rejects 4-digit area codes', () => {
    expect(numberSearchSchema.safeParse({ country: 'US', areaCode: '4155' }).success).toBe(false);
  });
});

describe('purchaseNumberSchema', () => {
  it('requires E.164', () => {
    expect(purchaseNumberSchema.safeParse({ phoneNumber: '4155552671' }).success).toBe(false);
    expect(purchaseNumberSchema.safeParse({ phoneNumber: '+14155552671' }).success).toBe(true);
  });
});

describe('sendMessageSchema', () => {
  it('enforces body length', () => {
    const long = 'x'.repeat(1601);
    expect(sendMessageSchema.safeParse({ to: '+14155552671', body: long }).success).toBe(false);
    expect(sendMessageSchema.safeParse({ to: '+14155552671', body: 'hi' }).success).toBe(true);
  });
});

describe('prepareOutboundCallSchema', () => {
  it('normalizes pasted U.S. phone numbers for outbound calls', () => {
    const parsed = prepareOutboundCallSchema.parse({
      selectedNumberId: '00000000-0000-4000-8000-000000000000',
      destinationNumber: `Services: Jiu-Jitsu
1215 Colusa Ave Unit Q, Yuba City, CA 95991, United States
+1 530-441-9961
Reviews`,
    });

    expect(parsed.destinationNumber).toBe('+15304419961');
  });
});
