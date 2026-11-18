'use strict';
// Run: node --test workers/maps-refresh/

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const lib = require('./lib.cjs');

// Same rule as the scraper's placeIdFromUrl, enough for these tests.
const placeId = (url) => (String(url).match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i) || [])[1] || '';
const url = (id, name = 'X') =>
  `https://www.google.com/maps/place/${name}/data=!4m7!3m6!1s${id}!8m2!3d33.7!4d-96.6`;

const HEADERS = [
  'title',
  'websiteUrl',
  'rating',
  'reviewCount',
  'category',
  'address',
  'phoneNumber',
  'facebookUrl',
  'instagramUrl',
  'twitterUrl',
  'linkedinUrl',
  'youtubeUrl',
  'qualityScore',
  'qualityClass',
  'geographyValid',
  'geographyReason',
  'target',
  'placeUrl',
  'relevance',
  'businessStatus',
  'email',
  'Status',
];
function sheetRow({ title, address = '1 Main St, Austin, TX 78701', phone = '', id }) {
  const row = Array(HEADERS.length).fill('');
  row[0] = title;
  row[5] = address;
  row[6] = phone;
  row[17] = url(id, title);
  return row;
}
function scraped(fields) {
  return {
    title: 'New Dojo',
    websiteUrl: 'https://newdojo.com',
    rating: '4.9',
    reviewCount: '31',
    category: 'Martial arts school',
    address: '9 Elm St, Dallas, TX 75201',
    phoneNumber: '+1 (214) 555-0100',
    qualityScore: '100',
    qualityClass: 'ACCEPT',
    geographyValid: 'true',
    target: 'Dallas County, Texas, USA',
    relevance: 'relevant',
    businessStatus: '',
    ...fields,
  };
}
const texas = (rows) => ({ title: 'Texas', headers: HEADERS, rows });

describe('parseCountiesFile', () => {
  const text = [
    'The counties in Alabama are: Autauga, Baldwin, St. Clair. ',
    '***********',
    'The boroughs and census areas in Alaska are: Anchorage Borough, Valdez-Cordova Census Area.',
    'The counties in Kentucky are: Wolfe, and Woodford County.',
  ].join('\r\n');

  it('reads every state line in order, whatever the area is called', () => {
    const states = lib.parseCountiesFile(text);
    assert.deepEqual(
      states.map((s) => s.abbr),
      ['AL', 'AK', 'KY'],
    );
    assert.deepEqual(states[0].counties, ['Autauga', 'Baldwin', 'St. Clair']);
    assert.equal(states[1].state, 'Alaska');
  });

  it('drops the "and" before the last county', () => {
    assert.deepEqual(lib.parseCountiesFile(text)[2].counties, ['Wolfe', 'Woodford County']);
  });
});

describe('matchCounty', () => {
  const counties = [
    { name: 'De Soto Parish' },
    { name: 'St. Croix County' },
    { name: 'Richmond County' },
    { name: 'Richmond city' },
    { name: 'Autauga County' },
  ];
  it('matches the census spelling', () => {
    assert.equal(lib.matchCounty('DeSoto Parish', counties).name, 'De Soto Parish');
    assert.equal(lib.matchCounty('Saint Croix County', counties).name, 'St. Croix County');
    assert.equal(lib.matchCounty('Autauga', counties).name, 'Autauga County');
  });
  it('never mixes an independent city with the county of the same name', () => {
    assert.equal(lib.matchCounty('Richmond city', counties).name, 'Richmond city');
    assert.equal(lib.matchCounty('Richmond County', counties).name, 'Richmond County');
  });
  it('reads a bare Virginia name as the independent city', () => {
    const virginia = [...counties, { name: 'Alexandria city' }, { name: 'Charles City County' }];
    assert.equal(lib.matchCounty('Richmond', virginia).name, 'Richmond city');
    assert.equal(lib.matchCounty('Alexandria', virginia).name, 'Alexandria city');
    assert.equal(lib.matchCounty('Charles City County', virginia).name, 'Charles City County');
  });
  it('returns null for a county the census no longer has', () => {
    assert.equal(lib.matchCounty('Valdez-Cordova Census Area', counties), null);
  });
});

describe('unanchoredSearchUrl', () => {
  it('builds the same search shape the scraper uses', () => {
    assert.equal(
      lib.unanchoredSearchUrl('martial arts schools', 'Valdez-Cordova Census Area', 'Alaska'),
      'https://www.google.com/maps/search/martial+arts+schools+in+Valdez-Cordova+Census+Area,+Alaska,+USA',
    );
  });
});

describe('weekId', () => {
  it('numbers ISO weeks', () => {
    assert.equal(lib.weekId(new Date(2026, 10, 18)), '2026-W47');
    assert.equal(lib.weekId(new Date(2026, 10, 22)), '2026-W47'); // Sunday
    assert.equal(lib.weekId(new Date(2026, 10, 23)), '2026-W48'); // Monday
    assert.equal(lib.weekId(new Date(2027, 0, 1)), '2026-W53');
  });
});

describe('phoneDigits and stateFromAddress', () => {
  it('compares numbers by their digits', () => {
    assert.equal(lib.phoneDigits('+1 (903) 515-5700'), '9035155700');
    assert.equal(lib.phoneDigits('903.515.5700'), '9035155700');
    assert.equal(lib.phoneDigits(''), '');
  });
  it('reads the state from the end of an address', () => {
    assert.equal(lib.stateFromAddress('678 FM 120, Pottsboro, TX 75076'), 'TX');
    assert.equal(lib.stateFromAddress('12 OK Corral Rd, Texarkana, AR 71854-1234'), 'AR');
    assert.equal(lib.stateFromAddress('Somewhere without a zip'), '');
  });
});

describe('planSync', () => {
  it('puts a changed phone number in column G of the matching row', () => {
    const tabs = [
      texas([sheetRow({ title: 'Old Dojo', phone: '+1 (512) 555-0000', id: '0x1:0xa' })]),
    ];
    const plan = lib.planSync({
      tabs,
      scraped: [
        scraped({ title: 'Old Dojo', placeUrl: url('0x1:0xa'), phoneNumber: '+1 (512) 555-9999' }),
      ],
      placeId,
    });
    assert.deepEqual(plan.updates, [
      {
        tab: 'Texas',
        row: 2,
        placeId: '0x1:0xa',
        title: 'Old Dojo',
        oldPhone: '+1 (512) 555-0000',
        newPhone: '+1 (512) 555-9999',
      },
    ]);
    assert.equal(plan.stats.added, 0);
  });

  it('fills an empty phone cell', () => {
    const tabs = [texas([sheetRow({ title: 'A', id: '0x1:0xa' })])];
    const plan = lib.planSync({
      tabs,
      scraped: [scraped({ placeUrl: url('0x1:0xa'), phoneNumber: '+1 (512) 555-1111' })],
      placeId,
    });
    assert.equal(plan.updates[0].newPhone, '+1 (512) 555-1111');
  });

  it('leaves the cell alone when only the formatting differs, or Maps shows no phone', () => {
    const tabs = [
      texas([
        sheetRow({ title: 'A', phone: '+1 (512) 555-0000', id: '0x1:0xa' }),
        sheetRow({ title: 'B', phone: '+1 (512) 555-2222', id: '0x2:0xb' }),
      ]),
    ];
    const plan = lib.planSync({
      tabs,
      scraped: [
        scraped({ placeUrl: url('0x1:0xa'), phoneNumber: '512-555-0000' }),
        scraped({ placeUrl: url('0x2:0xb'), phoneNumber: '' }),
      ],
      placeId,
    });
    assert.deepEqual(plan.updates, []);
    assert.equal(plan.stats.unchanged, 1);
    assert.equal(plan.stats.noPhoneOnMaps, 1);
  });

  it('finds a place listed in another state’s tab', () => {
    const oklahoma = {
      title: 'Oklahoma',
      headers: HEADERS,
      rows: [sheetRow({ title: 'A', phone: '1', id: '0x9:0x9' })],
    };
    const plan = lib.planSync({
      tabs: [texas([]), oklahoma],
      scraped: [scraped({ placeUrl: url('0x9:0x9'), phoneNumber: '+1 (405) 555-0000' })],
      placeId,
    });
    assert.equal(plan.updates[0].tab, 'Oklahoma');
    assert.equal(plan.stats.added, 0);
  });

  it('only writes G on tabs whose column G is the phone', () => {
    const odd = ['title', 'b', 'c', 'd', 'e', 'address', 'email', 'placeUrl'];
    const row = ['A', '', '', '', '', 'x', 'a@b.c', url('0x1:0xa')];
    const plan = lib.planSync({
      tabs: [{ title: 'Texas', headers: odd, rows: [row] }],
      scraped: [scraped({ placeUrl: url('0x1:0xa') })],
      placeId,
    });
    assert.deepEqual(plan.updates, []);
    assert.equal(plan.stats.skipped.phone_not_in_column_G, 1);
  });

  it('adds a new martial arts school to the tab for the state in its address', () => {
    const oklahoma = { title: 'Oklahoma', headers: HEADERS, rows: [] };
    const plan = lib.planSync({
      tabs: [texas([]), oklahoma],
      scraped: [scraped({ placeUrl: url('0x5:0x5'), address: '1 Main St, Durant, OK 74701' })],
      placeId,
      fallbackState: 'TX',
    });
    assert.deepEqual(Object.keys(plan.appends), ['Oklahoma']);
    const values = plan.appends.Oklahoma[0].values;
    assert.equal(values[0], 'New Dojo');
    assert.equal(values[2], 4.9);
    assert.equal(values[3], 31);
    assert.equal(values[6], '+1 (214) 555-0100');
    assert.equal(values[14], 1);
    assert.equal(values[17], url('0x5:0x5'));
    assert.equal(values[20], ''); // email: left for the email finder
    assert.equal(values.length, HEADERS.length);
  });

  it('fills the older tabs whose headers say "name" and "number"', () => {
    const headers = [
      'name',
      'websiteUrl',
      'rating',
      'reviewCount',
      'category',
      'address',
      'number',
      'placeUrl',
    ];
    const plan = lib.planSync({
      tabs: [{ title: 'ALABAMA', headers, rows: [] }],
      scraped: [scraped({ placeUrl: url('0x5:0x5'), address: '1 Main St, Auburn, AL 36830' })],
      placeId,
    });
    assert.deepEqual(plan.appends.ALABAMA[0].values.slice(0, 7), [
      'New Dojo',
      'https://newdojo.com',
      4.9,
      31,
      'Martial arts school',
      '1 Main St, Auburn, AL 36830',
      '+1 (214) 555-0100',
    ]);
  });

  it('does not add a place whose number or name and address are already listed', () => {
    const tabs = [
      texas([
        sheetRow({
          title: 'Old Dojo',
          address: '9 Elm St, Dallas, TX 75201',
          phone: '+1 (214) 555-0100',
          id: '0x1:0xa',
        }),
      ]),
    ];
    const plan = lib.planSync({
      tabs,
      scraped: [
        scraped({ placeUrl: url('0x7:0x7') }),
        scraped({ title: 'Old Dojo', placeUrl: url('0x8:0x8'), phoneNumber: '' }),
      ],
      placeId,
    });
    assert.deepEqual(plan.appends, {});
    assert.equal(plan.stats.skipped.phone_already_listed, 1);
    assert.equal(plan.stats.skipped.name_and_address_already_listed, 1);
  });

  it('adds nothing that is not a relevant martial arts listing, or has no state tab', () => {
    const plan = lib.planSync({
      tabs: [texas([])],
      scraped: [
        scraped({ placeUrl: url('0x1:0x1'), relevance: 'uncertain' }),
        scraped({
          placeUrl: url('0x2:0x2'),
          phoneNumber: '1',
          businessStatus: 'Permanently closed',
        }),
        scraped({
          placeUrl: url('0x3:0x3'),
          phoneNumber: '2',
          address: '1 K St, Washington, DC 20001',
        }),
        scraped({ placeUrl: 'https://example.com/no-id' }),
      ],
      placeId,
    });
    assert.deepEqual(plan.appends, {});
    assert.deepEqual(plan.stats.skipped, {
      not_martial_arts: 1,
      permanently_closed: 1,
      no_tab_for_state: 1,
      no_place_id: 1,
    });
  });

  it('uses the searched state when the address has no zip', () => {
    const plan = lib.planSync({
      tabs: [texas([])],
      scraped: [scraped({ placeUrl: url('0x1:0x1'), address: 'Main St, Austin' })],
      placeId,
      fallbackState: 'TX',
    });
    assert.equal(plan.appends.Texas.length, 1);
  });

  it('adds a place found twice only once', () => {
    const plan = lib.planSync({
      tabs: [texas([])],
      scraped: [scraped({ placeUrl: url('0x1:0x1') }), scraped({ placeUrl: url('0x1:0x1') })],
      placeId,
    });
    assert.equal(plan.appends.Texas.length, 1);
  });

  it('updates every row of a place listed twice', () => {
    const tabs = [
      texas([
        sheetRow({ title: 'A', phone: '+1 (512) 555-0000', id: '0x1:0xa' }),
        sheetRow({ title: 'A', phone: '+1 (512) 555-0000', id: '0x1:0xa' }),
      ]),
    ];
    const plan = lib.planSync({
      tabs,
      scraped: [scraped({ placeUrl: url('0x1:0xa'), phoneNumber: '+1 (512) 555-3333' })],
      placeId,
    });
    assert.deepEqual(
      plan.updates.map((u) => u.row),
      [2, 3],
    );
  });
});

describe('a1', () => {
  it('quotes tab titles', () => {
    assert.equal(lib.a1('New York', 'G12'), "'New York'!G12");
    assert.equal(lib.a1("O'Brien"), "'O''Brien'");
  });
});
