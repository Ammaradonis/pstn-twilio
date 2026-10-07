import { describe, expect, it } from 'vitest';

import { formatPhone } from './format';

describe('formatPhone', () => {
  it('formats US numbers', () => {
    expect(formatPhone('+16672206726')).toBe('+1 (667) 220-6726');
  });

  it('spaces UK numbers instead of running them together', () => {
    expect(formatPhone('+447918547441')).toBe('+44 7918 547441');
    expect(formatPhone('+442045726501')).toBe('+44 20 4572 6501');
  });
});
