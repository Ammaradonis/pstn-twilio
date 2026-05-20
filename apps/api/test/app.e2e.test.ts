// Placeholder Vitest sanity test so the test runner has at least one suite.
// Real e2e suites land in later phases (Auth in 5, Webhooks in 6+, etc).
import { describe, expect, it } from 'vitest';

import { APP_INFO } from '../src/common/app-info';

describe('APP_INFO', () => {
  it('reports the api name', () => {
    expect(APP_INFO.name).toBe('pstn-twilio-api');
  });
});
