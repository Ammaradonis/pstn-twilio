import type { MetaAdEvidenceDto } from '@pstn-twilio/shared';
import { describe, expect, it, vi } from 'vitest';

import { facebookKey, nameKey, schoolKey } from './facebook-url';
import { bestEvidence, matchRow, MetaAdsService, tabTitleFor } from './meta-ads.service';
import type { StoredEvidence } from './meta-ads.service';
import type { SheetsService } from './sheets.service';

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

function evidence(
  overrides: Partial<MetaAdEvidenceDto> & { schoolTitle: string },
): MetaAdEvidenceDto {
  return {
    spreadsheetId: 'sheet-1',
    sheetId: 7,
    sheetTitle: 'Texas',
    rowIndex: 2,
    facebookUrl: 'https://www.facebook.com/austinshotokan',
    advertiserName: overrides.schoolTitle,
    advertiserUrl: 'https://www.facebook.com/austinshotokan',
    adId: '1234567890',
    status: 'ACTIVE',
    startedAt: '2026-01-05',
    endedAt: null,
    observedAt: ago(1).toISOString(),
    ...overrides,
  };
}

const HEADER = ['title', 'address', 'email', 'facebookUrl', 'phoneNumber'];
const ROWS = [
  HEADER,
  [
    'Austin Shotokan',
    'Austin, TX',
    'a@x.test',
    'https://www.facebook.com/austinshotokan',
    '5125550001',
  ],
  ['Dallas Karate', 'Dallas, TX', 'd@x.test', '', '2145550002'],
  ['Houston Judo', 'Houston, TX', 'h@x.test', 'https://www.facebook.com/houstonjudo', '7135550003'],
  // The row links a page the evidence does not know: never matched by title alone.
  [
    'El Paso Aikido',
    'El Paso, TX',
    'e@x.test',
    'https://www.facebook.com/elpasoaikido-old',
    '9155550004',
  ],
  [
    'San Antonio Krav',
    'San Antonio, TX',
    's@x.test',
    'https://www.facebook.com/sanantoniokrav',
    '2105550005',
  ],
];

const EVIDENCE: MetaAdEvidenceDto[] = [
  evidence({ schoolTitle: 'Austin Shotokan', rowIndex: 2, status: 'ACTIVE' }),
  evidence({
    schoolTitle: 'Dallas Karate',
    rowIndex: 3,
    status: 'ACTIVE',
    adId: '2222222222',
    facebookUrl: 'https://www.facebook.com/dallaskarate',
  }),
  evidence({
    schoolTitle: 'Houston Judo',
    rowIndex: 4,
    status: 'ACTIVE',
    adId: '3333333333',
    facebookUrl: 'https://www.facebook.com/houstonjudo',
    observedAt: ago(200).toISOString(),
  }), // seen running once, five months ago
  evidence({
    schoolTitle: 'El Paso Aikido',
    rowIndex: 5,
    status: 'ACTIVE',
    adId: '4444444444',
    facebookUrl: 'https://www.facebook.com/elpasoaikido',
  }),
  evidence({
    schoolTitle: 'San Antonio Krav',
    rowIndex: 6,
    status: 'INACTIVE',
    adId: '5555555555',
    facebookUrl: 'https://www.facebook.com/sanantoniokrav',
    endedAt: '2025-03-01',
    startedAt: '2024-01-01',
  }),
  // No row in the tab carries this school any more.
  evidence({
    schoolTitle: 'Closed Dojo',
    rowIndex: 9,
    status: 'INACTIVE',
    adId: '6666666666',
    facebookUrl: 'https://www.facebook.com/closeddojo',
    endedAt: '2023-01-01',
  }),
];

function stubSheets(tabs = [{ sheetId: 7, title: 'Texas', columnCount: 5 }]) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const google = vi.fn(
    async (
      _token: string,
      url: string,
      _ctx: string,
      init?: { method?: string; body?: unknown },
    ) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
      if (
        url.endsWith(':batchUpdate') &&
        (init?.body as { requests?: unknown[] })?.requests?.[0] &&
        'addSheet' in (init?.body as { requests: Record<string, unknown>[] }).requests[0]!
      ) {
        return { replies: [{ addSheet: { properties: { sheetId: 99 } } }] };
      }
      return {};
    },
  );
  return {
    google,
    calls,
    service: {
      getAccessToken: async () => 'token',
      fetchTabs: async () => tabs,
      fetchRows: async () => ROWS,
      google,
    } as unknown as SheetsService,
  };
}

function stubPrisma(rows: MetaAdEvidenceDto[] = EVIDENCE) {
  // Prisma hands the service Date objects, not the DTO's ISO strings.
  const stored = rows.map((r) => ({
    ...r,
    startedAt: r.startedAt ? new Date(`${r.startedAt}T00:00:00Z`) : null,
    endedAt: r.endedAt ? new Date(`${r.endedAt}T00:00:00Z`) : null,
    observedAt: new Date(r.observedAt),
  }));
  return {
    metaAdEvidence: { findMany: vi.fn(async () => stored) },
    $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  } as unknown as ConstructorParameters<typeof MetaAdsService>[0];
}

describe('facebook page identity', () => {
  it('normalizes tracking parameters, hosts and numeric profiles', () => {
    expect(facebookKey('https://m.facebook.com/School/?ref=ads')).toBe(
      facebookKey('https://www.facebook.com/school'),
    );
    expect(facebookKey('https://facebook.com/people/My-School/123456/')).toBe('id:123456');
    expect(facebookKey('https://facebook.com/profile.php?id=123456')).toBe('id:123456');
    expect(facebookKey('https://facebook.com/ads/library/?id=1')).toBe('');
    expect(facebookKey('https://facebook.com.attacker.test/school')).toBe('');
  });

  it('compares school names the way the worker does', () => {
    expect(nameKey("St. Mary's Jujitsu & Academy")).toBe('st mary s jujitsu and academy');
    expect(schoolKey('School', 'https://facebook.com/school')).not.toBe(
      schoolKey('School', 'https://facebook.com/other'),
    );
  });
});

describe('meta ad filter tab name', () => {
  it('names the tab for the chosen filter', () => {
    expect(tabTitleFor('ACTIVE', 'Texas')).toBe('Meta ads - running now - Texas');
    expect(tabTitleFor('PAST', 'Texas')).toBe('Meta ads - ran in the past - Texas');
  });

  it('strips characters Sheets forbids and caps the length', () => {
    const title = tabTitleFor('ACTIVE', `A/B: "C" [D] ${'x'.repeat(120)}`);
    expect(title.length).toBeLessThanOrEqual(100);
    expect(title).not.toMatch(/[\\/?*[\]:"]/);
  });
});

describe('row matching on added or missing URLs', () => {
  const toStored = (e: MetaAdEvidenceDto): StoredEvidence => ({
    adId: e.adId,
    status: e.status,
    startedAt: null,
    endedAt: null,
    observedAt: new Date(e.observedAt),
    advertiserName: e.advertiserName,
    advertiserUrl: e.advertiserUrl,
    facebookUrl: e.facebookUrl,
    matchKind: e.matchKind === 'name' ? 'name' : 'page',
  });
  const byIdentity = new Map<string, StoredEvidence[]>();
  const byTitle = new Map<string, StoredEvidence[]>();
  for (const e of EVIDENCE) {
    const stored = toStored(e);
    const key = schoolKey(e.schoolTitle, e.facebookUrl);
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), stored]);
    const name = nameKey(e.schoolTitle);
    byTitle.set(name, [...(byTitle.get(name) ?? []), stored]);
  }

  it('matches a row whose URL cell is still empty when the page is unambiguous', () => {
    expect(matchRow('Dallas Karate', '', byIdentity, byTitle)).toHaveLength(1);
  });

  it('refuses a title-only match when the row points at a different page', () => {
    expect(
      matchRow('El Paso Aikido', 'https://www.facebook.com/elpasoaikido-old', byIdentity, byTitle),
    ).toHaveLength(0);
  });

  it('matches the same page written differently', () => {
    expect(
      matchRow(
        'Austin Shotokan',
        'https://m.facebook.com/AustinShotokan/?ref=page',
        byIdentity,
        byTitle,
      ),
    ).toHaveLength(1);
  });

  it('picks a running ad for ACTIVE and an ended one for PAST', () => {
    const running = toStored(evidence({ schoolTitle: 'X', status: 'ACTIVE', adId: '1' }));
    const ended: StoredEvidence = {
      ...toStored(evidence({ schoolTitle: 'X', status: 'INACTIVE', adId: '2' })),
      endedAt: new Date('2025-01-01'),
    };
    const both = [running, ended];
    expect(bestEvidence(both, 'ACTIVE', ago(30)).adId).toBe('1');
    expect(bestEvidence(both, 'PAST', ago(30)).adId).toBe('2');
  });
});

describe('name-only evidence, the case most tabs are in', () => {
  const index = (rows: MetaAdEvidenceDto[]) => {
    const byIdentity = new Map<string, StoredEvidence[]>();
    const byTitle = new Map<string, StoredEvidence[]>();
    for (const e of rows) {
      const stored: StoredEvidence = {
        adId: e.adId,
        status: e.status,
        startedAt: null,
        endedAt: null,
        observedAt: new Date(e.observedAt),
        advertiserName: e.advertiserName,
        advertiserUrl: e.advertiserUrl,
        facebookUrl: e.facebookUrl,
        matchKind: e.matchKind === 'name' ? 'name' : 'page',
      };
      const key = schoolKey(e.schoolTitle, e.facebookUrl);
      byIdentity.set(key, [...(byIdentity.get(key) ?? []), stored]);
      const name = nameKey(e.schoolTitle);
      byTitle.set(name, [...(byTitle.get(name) ?? []), stored]);
    }
    return { byIdentity, byTitle };
  };

  // What the worker uploads when the tab's facebookUrl cell is empty: the
  // advertiser's page, and the exact school name as the identity.
  const nameOnly = evidence({
    schoolTitle: 'Dallas Karate',
    facebookUrl: '',
    advertiserName: 'Dallas Karate',
    advertiserUrl: 'https://www.facebook.com/dallaskarate',
    matchKind: 'name',
  });

  it('matches a row whose facebookUrl cell is empty', () => {
    const { byIdentity, byTitle } = index([nameOnly]);
    expect(matchRow('Dallas Karate', '', byIdentity, byTitle)).toHaveLength(1);
  });

  it('still matches when the row page is filled in later', () => {
    // "Enrich socials" fills the cell after the worker ran: the page is the one
    // the ad ran from, so the row keeps its evidence.
    const { byIdentity, byTitle } = index([nameOnly]);
    expect(
      matchRow(
        'Dallas Karate',
        'https://m.facebook.com/DallasKarate/?ref=page',
        byIdentity,
        byTitle,
      ),
    ).toHaveLength(1);
  });

  it('refuses the row when it names a different page', () => {
    const { byIdentity, byTitle } = index([nameOnly]);
    expect(
      matchRow('Dallas Karate', 'https://www.facebook.com/dallaskarate-old', byIdentity, byTitle),
    ).toHaveLength(0);
  });

  it('refuses a name two different advertisers use', () => {
    const { byIdentity, byTitle } = index([
      nameOnly,
      evidence({
        schoolTitle: 'Dallas Karate',
        adId: '9999999999',
        facebookUrl: '',
        advertiserUrl: 'https://www.facebook.com/dallaskarate2',
        matchKind: 'name',
      }),
    ]);
    expect(matchRow('Dallas Karate', '', byIdentity, byTitle)).toHaveLength(0);
    // Naming the row's own page resolves the ambiguity.
    expect(
      matchRow('Dallas Karate', 'https://www.facebook.com/dallaskarate2', byIdentity, byTitle),
    ).toHaveLength(1);
  });
});

describe('the Meta ad filter', () => {
  it('keeps only rows advertising now by default', async () => {
    const sheets = stubSheets();
    const service = new MetaAdsService(stubPrisma(), sheets.service);
    const result = await service.filter('user', 'sheet-1', 'Texas', 'ACTIVE');

    expect(result.tabTitle).toBe('Meta ads - running now - Texas');
    expect(result.reused).toBe(false);
    expect(result.rows).toBe(2);
    expect(result.sourceRows).toBe(5);
    // Houston's "Active" observation is five months old: not advertising now.
    expect(result.staleRows).toBe(1);
    // Only Closed Dojo has no row left in the tab.
    expect(result.orphaned).toBe(1);

    const written = sheets.calls.find((c) => c.method === 'PUT')!;
    expect(written.url).toContain('valueInputOption=RAW');
    const values = (written.body as { values: string[][] }).values;
    expect(values[0]).toEqual([
      ...HEADER,
      'metaAdId',
      'metaAdStatus',
      'metaAdStarted',
      'metaAdEnded',
      'metaAdvertiser',
      'metaAdObservedAt',
      'metaMatch',
    ]);
    expect(values.slice(1).map((r) => r[0])).toEqual(['Austin Shotokan', 'Dallas Karate']);
    expect(values[1]![5]).toBe('1234567890');
    expect(values[1]![6]).toBe('Running');
    expect(values[1]![7]).toBe('2026-01-05');
    expect(values[1]![8]).toBe('');
    // Which identity matched: this tab's own page was the ad's page.
    expect(values[1]![11]).toBe('page');
  });

  it('offers the past filter separately', async () => {
    const sheets = stubSheets();
    const service = new MetaAdsService(stubPrisma(), sheets.service);
    const result = await service.filter('user', 'sheet-1', 'Texas', 'PAST');

    expect(result.tabTitle).toBe('Meta ads - ran in the past - Texas');
    expect(result.rows).toBe(1);
    const written = sheets.calls.find((c) => c.method === 'PUT')!;
    const values = (written.body as { values: string[][] }).values;
    expect(values[1]![0]).toBe('San Antonio Krav');
    expect(values[1]![6]).toBe('Ended');
    expect(values[1]![8]).toBe('2025-03-01');
    expect(values[1]![11]).toBe('page');
  });

  it('copies a name-only match and labels it as one', async () => {
    const sheets = stubSheets();
    const service = new MetaAdsService(
      stubPrisma([
        evidence({
          schoolTitle: 'Dallas Karate',
          rowIndex: 3,
          facebookUrl: '',
          advertiserUrl: 'https://www.facebook.com/dallaskarate',
          matchKind: 'name',
        }),
      ]),
      sheets.service,
    );
    const result = await service.filter('user', 'sheet-1', 'Texas', 'ACTIVE');
    expect(result.rows).toBe(1);
    const written = sheets.calls.find((c) => c.method === 'PUT')!;
    const values = (written.body as { values: string[][] }).values;
    expect(values[1]![0]).toBe('Dallas Karate');
    expect(values[1]![5]).toBe('1234567890');
    // The tab never presents a name match as a page match.
    expect(values[1]![11]).toBe('name');
  });

  it('rewrites its own tab on a second press instead of stacking copies', async () => {
    const sheets = stubSheets([
      { sheetId: 7, title: 'Texas', columnCount: 5 },
      { sheetId: 42, title: 'Meta ads - running now - Texas', columnCount: 11 },
    ]);
    const service = new MetaAdsService(stubPrisma(), sheets.service);
    const result = await service.filter('user', 'sheet-1', 'Texas', 'ACTIVE');

    expect(result.reused).toBe(true);
    expect(sheets.calls.some((c) => c.url.endsWith(':clear'))).toBe(true);
    expect(
      sheets.calls.some(
        (c) => c.url.endsWith(':batchUpdate') && JSON.stringify(c.body).includes('"rowCount"'),
      ),
    ).toBe(true);
    expect(sheets.calls.some((c) => JSON.stringify(c.body).includes('addSheet'))).toBe(false);
  });

  it('explains an empty evidence store instead of making a blank tab', async () => {
    const sheets = stubSheets();
    const service = new MetaAdsService(stubPrisma([]), sheets.service);
    await expect(service.filter('user', 'sheet-1', 'Texas', 'ACTIVE')).rejects.toThrow(
      /has not reported any matches/,
    );
    expect(sheets.calls).toHaveLength(0);
  });

  it('still creates the tab when nothing matches, so the result is visible', async () => {
    const sheets = stubSheets();
    const service = new MetaAdsService(
      stubPrisma([
        evidence({ schoolTitle: 'Closed Dojo', facebookUrl: 'https://facebook.com/closeddojo' }),
      ]),
      sheets.service,
    );
    const result = await service.filter('user', 'sheet-1', 'Texas', 'ACTIVE');
    expect(result.rows).toBe(0);
    const written = sheets.calls.find((c) => c.method === 'PUT')!;
    expect((written.body as { values: string[][] }).values).toHaveLength(1);
  });
});

describe('the button status', () => {
  it('counts schools running now, in the past, and both', async () => {
    const sheets = stubSheets();
    const service = new MetaAdsService(
      stubPrisma([
        evidence({ schoolTitle: 'A', status: 'ACTIVE', adId: '1' }),
        evidence({ schoolTitle: 'A', status: 'INACTIVE', adId: '2', endedAt: '2025-01-01' }),
        evidence({ schoolTitle: 'B', status: 'INACTIVE', adId: '3', endedAt: '2024-01-01' }),
        evidence({
          schoolTitle: 'C',
          status: 'ACTIVE',
          adId: '4',
          observedAt: ago(90).toISOString(),
        }),
      ]),
      sheets.service,
    );
    const status = await service.status('user', 'sheet-1', 'Texas');
    expect(status).toMatchObject({ active: 1, past: 2, both: 1, matched: 3, evidence: 4 });
    expect(status.lastObservedAt).toBeTruthy();
  });
});
