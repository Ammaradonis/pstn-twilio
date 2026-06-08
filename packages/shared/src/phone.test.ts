import { describe, expect, it } from 'vitest';

import { normalizeDialablePhoneNumber } from './phone';

describe('normalizeDialablePhoneNumber', () => {
  it.each([
    ['+1 530-441-9961', '+15304419961'],
    ['530-441-9961', '+15304419961'],
    ['(530) 441-9961', '+15304419961'],
    ['530.441.9961', '+15304419961'],
    ['530/441/9961', '+15304419961'],
    ['530 441 9961', '+15304419961'],
    ["530'441'9961", '+15304419961'],
    ['530‘441’9961', '+15304419961'],
    ['530,441,9961', '+15304419961'],
    ['15304419961', '+15304419961'],
    ['+15304419961', '+15304419961'],
    ['530-441-9961 ext. 123', '+15304419961'],
    ['Tel: +44 7911 123456', '+447911123456'],
    ['Main office ＋1 (530) 441–9961', '+15304419961'],
    ['+447911123456', '+447911123456'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeDialablePhoneNumber(input)).toBe(expected);
  });

  it('extracts the phone number from pasted business listing text', () => {
    const pasted = `Services: Jiu-Jitsu, Adult Classes, BJJ, Brazilian Jiu
1215 Colusa Ave Unit Q, Yuba City, CA 95991, United States
Map of Ground-Up Brazilian Jiu-Jitsu Academy, LLC
+1 530-441-9961
Reviews
Reviews aren't verified`;

    expect(normalizeDialablePhoneNumber(pasted)).toBe('+15304419961');
  });

  it('extracts an incorrectly formatted phone number from noisy clipboard text', () => {
    const pasted = 'Call now!!! phone +1/530/441/9961, ask for front desk';

    expect(normalizeDialablePhoneNumber(pasted)).toBe('+15304419961');
  });

  it.each(['', '1215 Colusa Ave Yuba City CA 95991', '5551111111', '+0123'])(
    'rejects %s',
    (input) => {
      expect(normalizeDialablePhoneNumber(input)).toBeNull();
    },
  );
});
