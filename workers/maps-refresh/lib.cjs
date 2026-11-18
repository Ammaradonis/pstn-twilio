'use strict';
// Pure helpers for the weekly U.S. Conquest refresh (see refresh.cjs). Nothing here
// touches the network, the disk or the scraper, so it is all unit-tested.

const STATE_NAMES = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
};

/** Column G, the phone number, as a 0-based index. */
const PHONE_COL = 6;
const PHONE_HEADERS = new Set(['phonenumber', 'number', 'phone']);
// Older tabs (ALABAMA, ALASKA) name two columns differently.
const HEADER_ALIASES = { name: 'title', number: 'phoneNumber', phone: 'phoneNumber' };
const NUMERIC_FIELDS = new Set(['rating', 'reviewCount', 'qualityScore']);

function stateAbbrev(value) {
  const text = String(value || '').trim();
  if (STATE_NAMES[text.toUpperCase()]) return text.toUpperCase();
  const lower = text.toLowerCase();
  return Object.keys(STATE_NAMES).find((abbr) => STATE_NAMES[abbr].toLowerCase() === lower) || '';
}

/**
 * all-us-counties.txt: one line per state, "The counties in Alabama are: Autauga, Baldwin, …".
 * Returns [{ abbr, state, counties: [names as written] }] in file order.
 */
function parseCountiesFile(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const match = line.match(/^The\s+.+?\s+in\s+([^:]+?)\s+are:\s+(.+?)\.?$/i);
    if (!match) continue;
    const abbr = stateAbbrev(match[1]);
    if (!abbr) continue;
    const counties = match[2]
      .split(/,\s*/)
      .map((name) =>
        name
          .trim()
          .replace(/\.$/, '')
          .replace(/^and\s+/i, '')
          .trim(),
      )
      .filter(Boolean);
    out.push({ abbr, state: STATE_NAMES[abbr], counties });
  }
  return out;
}

const COUNTY_SUFFIX =
  /\s+(county|parish|city and borough|borough|census area|planning region|municipality)$/i;

/** A county name's comparable core and kind: "St. Croix County" -> { key: "stcroix", kind: "county" }. */
function countyParts(name) {
  let text = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/^saint\s+/, 'st ');
  let kind = 'bare';
  if (COUNTY_SUFFIX.test(text)) {
    text = text.replace(COUNTY_SUFFIX, '');
    kind = 'county';
  } else if (/\scity$/.test(text)) {
    text = text.replace(/\scity$/, '');
    kind = 'city';
  }
  return { key: text.replace(/[^a-z]/g, ''), kind };
}

/**
 * The census county for a name from the counties file. The file and the census
 * spell a few differently ("DeSoto Parish" / "De Soto Parish", "Saint Croix" /
 * "St. Croix"). Virginia's file line names independent cities bare ("Richmond")
 * and counties with the suffix ("Richmond County"), so a bare name that fits
 * both is the city, and the census's "Richmond city".
 */
function matchCounty(name, counties) {
  const exact = String(name).trim().toLowerCase();
  const byName = counties.find((county) => county.name.toLowerCase() === exact);
  if (byName) return byName;
  const want = countyParts(name);
  const candidates = counties.filter((county) => countyParts(county.name).key === want.key);
  if (want.kind !== 'bare') {
    return candidates.find((county) => countyParts(county.name).kind === want.kind) || null;
  }
  if (candidates.length <= 1) return candidates[0] || null;
  return candidates.find((county) => countyParts(county.name).kind === 'city') || candidates[0];
}

function searchTerm(text) {
  return encodeURIComponent(text).replace(/%20/g, '+').replace(/%2C/gi, ',');
}

/** A Maps search for a county the census list doesn't know: no viewport, Google picks the area. */
function unanchoredSearchUrl(query, countyName, stateName) {
  return `https://www.google.com/maps/search/${searchTerm(query)}+in+${searchTerm(
    `${countyName}, ${stateName}, USA`,
  )}`;
}

/** ISO week of a date in local time, e.g. "2026-W47". A new weekly run starts each new week. */
function weekId(date = new Date()) {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = (day.getDay() + 6) % 7; // Monday 0
  day.setDate(day.getDate() - weekday + 3); // the week's Thursday decides its year
  const firstThursday = new Date(day.getFullYear(), 0, 4);
  const week =
    1 + Math.round(((day - firstThursday) / 86400000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
  return `${day.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** National digits of a US number, so "+1 (903) 515-5700" and "903-515-5700" compare equal. */
function phoneDigits(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits.length >= 7 ? digits : '';
}

/** The state of a Maps address: "678 FM 120, Pottsboro, TX 75076" -> "TX". */
function stateFromAddress(address) {
  const matches = [...String(address || '').matchAll(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/g)];
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    if (STATE_NAMES[matches[i][1]]) return matches[i][1];
  }
  return '';
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function nameAddressKey(title, address) {
  const name = normalizeText(title);
  const where = normalizeText(address);
  return name && where ? `${name}|${where}` : '';
}

function normHeader(header) {
  return String(header || '')
    .trim()
    .toLowerCase();
}

function cellValue(field, raw) {
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (NUMERIC_FIELDS.has(field) && text !== '' && Number.isFinite(Number(text)))
    return Number(text);
  // The sheet stores the flag as 1/0 (the scraper writes true/false).
  if (field === 'geographyValid') {
    if (text === 'true') return 1;
    if (text === 'false') return 0;
  }
  return text;
}

/** A scraped row laid out under one tab's own headers; columns the scraper doesn't fill stay blank. */
function rowValues(headers, scraped) {
  const lowerKeys = new Map(Object.keys(scraped).map((key) => [key.toLowerCase(), key]));
  return headers.map((header) => {
    const name = normHeader(header);
    const field = HEADER_ALIASES[name] || String(header).trim();
    const key = lowerKeys.get(field.toLowerCase());
    return key ? cellValue(key, scraped[key]) : '';
  });
}

/**
 * What one state's scrape changes in the workbook.
 *
 * tabs:    [{ title, headers, rows }]; rows exclude the header, so rows[i] is sheet row i + 2.
 * scraped: the scraper's consolidated rows (master.csv).
 * placeId: url -> Google place id (the scraper's placeIdFromUrl).
 *
 * Known places (matched by place id anywhere in the workbook) get column G set to
 * the phone Maps lists now. Only a found number replaces one: a listing that
 * shows no phone this week leaves the cell alone. Places in no tab are new: a
 * relevant martial arts listing whose phone and name+address aren't listed
 * either goes to the bottom of the tab for the state in its address.
 */
function planSync({ tabs, scraped, placeId, fallbackState = '' }) {
  const stats = {
    scraped: scraped.length,
    matched: 0,
    unchanged: 0,
    noPhoneOnMaps: 0,
    phoneUpdates: 0,
    added: 0,
    skipped: {},
  };
  const skip = (reason) => {
    stats.skipped[reason] = (stats.skipped[reason] || 0) + 1;
  };

  const byId = new Map();
  const phones = new Set();
  const names = new Set();
  const tabByState = new Map();
  const info = new Map();
  for (const tab of tabs) {
    const abbr = stateAbbrev(tab.title);
    if (abbr) tabByState.set(abbr, tab);
    const headers = tab.headers.map(normHeader);
    const meta = {
      phoneIsG: PHONE_HEADERS.has(headers[PHONE_COL]),
      placeCol: headers.indexOf('placeurl'),
      titleCol: headers.findIndex((h) => h === 'title' || h === 'name'),
      addressCol: headers.indexOf('address'),
    };
    info.set(tab, meta);
    tab.rows.forEach((row, i) => {
      const id = meta.placeCol >= 0 ? placeId(row[meta.placeCol] || '') : '';
      if (id) {
        if (!byId.has(id)) byId.set(id, []);
        byId.get(id).push({ tab, row: i + 2, phone: row[PHONE_COL] || '' });
      }
      const digits = phoneDigits(row[PHONE_COL]);
      if (digits) phones.add(digits);
      const key = nameAddressKey(row[meta.titleCol], row[meta.addressCol]);
      if (key) names.add(key);
    });
  }

  const updates = [];
  const touched = new Set();
  const appends = {};
  for (const place of scraped) {
    const id = placeId(place.placeUrl || '');
    if (!id) {
      skip('no_place_id');
      continue;
    }
    const fresh = phoneDigits(place.phoneNumber);
    const known = byId.get(id);
    if (known) {
      stats.matched += 1;
      for (const spot of known) {
        if (!info.get(spot.tab).phoneIsG) {
          skip('phone_not_in_column_G');
          continue;
        }
        if (!fresh) {
          stats.noPhoneOnMaps += 1;
          continue;
        }
        if (phoneDigits(spot.phone) === fresh) {
          stats.unchanged += 1;
          continue;
        }
        const cell = `${spot.tab.title}!${spot.row}`;
        if (touched.has(cell)) continue;
        touched.add(cell);
        updates.push({
          tab: spot.tab.title,
          row: spot.row,
          placeId: id,
          title: place.title || '',
          oldPhone: spot.phone,
          newPhone: String(place.phoneNumber).trim(),
        });
      }
      continue;
    }

    if (place.relevance !== 'relevant') {
      skip('not_martial_arts');
      continue;
    }
    if (/permanently closed/i.test(place.businessStatus || '')) {
      skip('permanently_closed');
      continue;
    }
    if (fresh && phones.has(fresh)) {
      skip('phone_already_listed');
      continue;
    }
    const key = nameAddressKey(place.title, place.address);
    if (key && names.has(key)) {
      skip('name_and_address_already_listed');
      continue;
    }
    const abbr = stateFromAddress(place.address) || fallbackState;
    const tab = tabByState.get(abbr);
    if (!tab) {
      skip('no_tab_for_state');
      continue;
    }
    (appends[tab.title] = appends[tab.title] || []).push({
      placeId: id,
      title: place.title || '',
      values: rowValues(tab.headers, place),
    });
    byId.set(id, [{ tab, row: -1, phone: place.phoneNumber || '' }]);
    if (fresh) phones.add(fresh);
    if (key) names.add(key);
    stats.added += 1;
  }
  stats.phoneUpdates = updates.length;
  return { updates, appends, stats };
}

/** "A1" notation for a tab: titles are quoted, with quotes doubled. */
function a1(title, range = '') {
  const quoted = `'${String(title).replace(/'/g, "''")}'`;
  return range ? `${quoted}!${range}` : quoted;
}

module.exports = {
  STATE_NAMES,
  PHONE_COL,
  stateAbbrev,
  parseCountiesFile,
  matchCounty,
  unanchoredSearchUrl,
  weekId,
  phoneDigits,
  stateFromAddress,
  rowValues,
  planSync,
  a1,
};
