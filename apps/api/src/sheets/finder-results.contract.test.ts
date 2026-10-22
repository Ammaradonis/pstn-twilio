/**
 * The worker result contract, as the API enforces it.
 *
 * Enrichment rows succeed on social links alone, so they are the one case where
 * FOUND carries no email. The API used to reject those with
 * "results.0: FOUND requires email", which silently discarded every enrichment
 * result that had actually found something.
 */
import { describe, expect, it } from 'vitest';

import { finderResultsSchema } from './sheets.controller';

const base = {
  id: '11111111-1111-4111-8111-111111111111',
  leaseToken: '22222222-2222-4222-8222-222222222222',
  researchComplete: true,
};

const enrichment = { facebookUrl: 'https://www.facebook.com/dojo' };

describe('email finder worker results', () => {
  it('accepts an ENRICH result that found socials but no email', () => {
    const parsed = finderResultsSchema.safeParse({
      results: [{ ...base, status: 'FOUND', email: null, enrichment, mode: 'ENRICH' }],
    });
    expect(parsed.success).toBe(true);
  });

  it('still rejects a FOUND address result with no email', () => {
    const parsed = finderResultsSchema.safeParse({
      results: [{ ...base, status: 'FOUND', email: null, mode: 'EMAIL' }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message)).toContain('FOUND requires email');
    }
  });

  it('rejects an ENRICH FOUND that carries no social link', () => {
    const parsed = finderResultsSchema.safeParse({
      results: [{ ...base, status: 'FOUND', email: null, mode: 'ENRICH' }],
    });
    expect(parsed.success).toBe(false);
  });

  it('defaults to the address rules when a worker sends no mode', () => {
    // An older worker, so nothing that used to pass starts failing.
    expect(
      finderResultsSchema.safeParse({
        results: [{ ...base, status: 'FOUND', email: 'owner@dojo.org' }],
      }).success,
    ).toBe(true);
    expect(
      finderResultsSchema.safeParse({ results: [{ ...base, status: 'FOUND', email: null }] })
        .success,
    ).toBe(false);
  });
});
