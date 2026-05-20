import { CallStatus } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { mapTwilioCallStatus } from './voice-status.mapper';

describe('mapTwilioCallStatus', () => {
  it.each([
    ['initiated', CallStatus.INITIATED],
    ['ringing', CallStatus.RINGING],
    ['in-progress', CallStatus.IN_PROGRESS],
    ['answered', CallStatus.IN_PROGRESS],
    ['completed', CallStatus.COMPLETED],
    ['busy', CallStatus.BUSY],
    ['failed', CallStatus.FAILED],
    ['no-answer', CallStatus.NO_ANSWER],
    ['canceled', CallStatus.CANCELED],
  ])('maps %s -> %s', (raw, expected) => {
    expect(mapTwilioCallStatus(raw)).toBe(expected);
  });

  it('treats unknown values as INITIATED (safe default for first webhook)', () => {
    expect(mapTwilioCallStatus('something-new')).toBe(CallStatus.INITIATED);
  });

  it('is case-insensitive', () => {
    expect(mapTwilioCallStatus('IN-PROGRESS')).toBe(CallStatus.IN_PROGRESS);
    expect(mapTwilioCallStatus('Ringing')).toBe(CallStatus.RINGING);
  });
});
