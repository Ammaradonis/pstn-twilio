/**
 * The worker's evidence upload, validated.
 *
 * Two bugs in this schema made the Dial page's "Meta ad filter" look dead: the
 * sheet ids were capped at 2,000,000,000 (Google's are positive int32, and
 * Massachusetts is 2,079,617,744, so its whole batch was rejected with a 400),
 * and `facebookUrl` had to be non-empty (the worker had nothing to put there for
 * a tab with no page). Both are pinned here.
 */

import { describe, expect, it } from 'vitest';

import { evidenceSchema, MAX_SHEET_ID } from './meta-ads.controller';

function observation(overrides: Record<string, unknown> = {}) {
  return {
    spreadsheetId: '1hEen_n9M27n5bjyXpsnaHXpvG7S5eHHmPl6HG2LhRnM',
    sheetId: 1508712293,
    sheetTitle: 'Texas',
    rowIndex: 29,
    schoolTitle: "DaSilva's Karate",
    facebookUrl: '',
    advertiserName: "Dasilva's Karate",
    advertiserUrl: 'https://www.facebook.com/dasilvaskarate/',
    adId: '1458740838110326',
    status: 'ACTIVE',
    startedAt: '2024-07-15',
    endedAt: null,
    observedAt: '2026-10-22T09:51:54.588Z',
    ...overrides,
  };
}

describe('the evidence upload schema', () => {
  it('accepts a name-only match with no page on the row', () => {
    const parsed = evidenceSchema.parse({ observations: [observation()] });
    expect(parsed.observations[0]!.facebookUrl).toBe('');
    // An older worker sent no matchKind; those rows were page matches.
    expect(parsed.observations[0]!.matchKind).toBe('page');
  });

  it('accepts every Google sheet id, up to int32', () => {
    const parsed = evidenceSchema.parse({
      observations: [observation({ sheetId: MAX_SHEET_ID, sheetTitle: 'Massachusetts' })],
    });
    expect(parsed.observations[0]!.sheetId).toBe(2_147_483_647);
    // The old ceiling, which is inside the real range.
    expect(
      evidenceSchema.safeParse({ observations: [observation({ sheetId: 2_079_617_744 })] }).success,
    ).toBe(true);
    expect(
      evidenceSchema.safeParse({ observations: [observation({ sheetId: 2_147_483_648 })] }).success,
    ).toBe(false);
  });

  it('keeps matchKind explicit when the worker sends one', () => {
    const parsed = evidenceSchema.parse({
      observations: [observation({ matchKind: 'name' })],
    });
    expect(parsed.observations[0]!.matchKind).toBe('name');
  });

  it('still refuses rows that cannot be traced to an ad', () => {
    expect(
      evidenceSchema.safeParse({ observations: [observation({ adId: 'not-a-number' })] }).success,
    ).toBe(false);
    expect(
      evidenceSchema.safeParse({ observations: [observation({ status: 'UNKNOWN' })] }).success,
    ).toBe(false);
    expect(evidenceSchema.safeParse({ observations: [] }).success).toBe(false);
    expect(evidenceSchema.safeParse({ observations: [observation({ rowIndex: 1 })] }).success).toBe(
      false,
    );
  });
});
