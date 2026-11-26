'use strict';
// Opening hours for the U.S. Conquest `openingTimes` column.
//
// The source is the school's Google Business Profile: the scraper reads the
// week off the Maps place panel (real-google-maps-scraper/extract/openingHours.js)
// and writes it in the format below. When Maps lists no hours, the school's own
// website is read: schema.org data first (JSON-LD openingHoursSpecification /
// openingHours, microdata), then an "Hours" block in the page text.
//
// One line per school, consecutive days with the same hours grouped:
//   "Mon–Thu 4–9 PM; Fri 4–8 PM; Sat 9 AM–12 PM; Sun closed"
// Keep formatWeek identical to the scraper's (hours.test.cjs compares them).

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const SHORT = {
  Monday: 'Mon',
  Tuesday: 'Tue',
  Wednesday: 'Wed',
  Thursday: 'Thu',
  Friday: 'Fri',
  Saturday: 'Sat',
  Sunday: 'Sun',
};

/** { Monday: "4–9 PM", … } -> "Mon–Thu 4–9 PM; Fri 4–8 PM; Sun closed". */
function formatWeek(days) {
  const groups = [];
  for (let i = 0; i < DAYS.length; i += 1) {
    const hours = days?.[DAYS[i]];
    if (!hours) continue;
    const last = groups[groups.length - 1];
    if (last && last.hours === hours && last.end === i - 1) last.end = i;
    else groups.push({ start: i, end: i, hours });
  }
  return groups
    .map(
      ({ start, end, hours }) =>
        `${start === end ? SHORT[DAYS[start]] : `${SHORT[DAYS[start]]}–${SHORT[DAYS[end]]}`} ${hours}`,
    )
    .join('; ');
}

/** The days a formatted line has regular hours for: "Mon–Wed 4–9 PM; Thu holiday; Fri closed" -> 4. */
function daysCovered(line) {
  let count = 0;
  for (const part of String(line || '').split(';')) {
    const m = part
      .trim()
      .match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:–(Mon|Tue|Wed|Thu|Fri|Sat|Sun))?\b/);
    // "Thu–Fri holiday": Maps showed holiday hours, not the regular ones.
    if (!m || /^\S+\s+holiday$/i.test(part.trim())) continue;
    const order = Object.values(SHORT);
    const start = order.indexOf(m[1]);
    const end = m[2] ? order.indexOf(m[2]) : start;
    if (end >= start) count += end - start + 1;
  }
  return count;
}

// ── times ─────────────────────────────────────────────────────────────────────

/**
 * Minutes since midnight from "16:30", "4:30 pm", "4pm", "noon", "midnight"; null if
 * unreadable. Without am/pm (its own or the hint) the time is read as 24-hour.
 */
function minutes(text, meridiemHint = '') {
  const t = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\./g, '');
  if (/^(?:12\s*)?noon$/.test(t)) return 12 * 60;
  if (/^(?:12\s*)?midnight$/.test(t)) return 24 * 60;
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m?)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] || 0);
  if (minute > 59) return null;
  const meridiem = (m[3] || meridiemHint || '').charAt(0);
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'a') hour = hour === 12 ? 0 : hour;
    else hour = hour === 12 ? 12 : hour + 12;
  } else if (hour > 24) {
    return null;
  }
  return hour * 60 + minute;
}

function clock(total) {
  const t = ((total % 1440) + 1440) % 1440;
  const hour24 = Math.floor(t / 60);
  const minute = t % 60;
  const meridiem = hour24 < 12 ? 'AM' : 'PM';
  const hour = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return { text: minute ? `${hour}:${String(minute).padStart(2, '0')}` : String(hour), meridiem };
}

/** 960, 1260 -> "4–9 PM"; 540, 720 -> "9 AM–12 PM"; 0, 1440 -> "open 24 hours". */
function formatRange(open, close) {
  if (open === 0 && (close === 1440 || close === 1439)) return 'open 24 hours';
  const a = clock(open);
  const b = clock(close === 1440 ? 0 : close);
  if (close === 1440) b.meridiem = 'AM';
  return a.meridiem === b.meridiem
    ? `${a.text}–${b.text} ${b.meridiem}`
    : `${a.text} ${a.meridiem}–${b.text} ${b.meridiem}`;
}

// ── days ──────────────────────────────────────────────────────────────────────

const DAY_WORDS = [
  [/^mo(?:n(?:day)?)?$/, 'Monday'],
  [/^tu(?:e(?:s(?:day)?)?)?$/, 'Tuesday'],
  [/^we(?:d(?:nesday)?)?$/, 'Wednesday'],
  [/^th(?:u(?:r(?:s(?:day)?)?)?)?$/, 'Thursday'],
  [/^fr(?:i(?:day)?)?$/, 'Friday'],
  [/^sa(?:t(?:urday)?)?$/, 'Saturday'],
  [/^su(?:n(?:day)?)?$/, 'Sunday'],
];

function dayName(word) {
  const w = String(word || '')
    .toLowerCase()
    .replace(/^https?:\/\/schema\.org\//, '')
    .replace(/[^a-z]/g, '');
  for (const [re, day] of DAY_WORDS) if (re.test(w)) return day;
  return null;
}

function dayRange(from, to) {
  const a = DAYS.indexOf(from);
  const b = DAYS.indexOf(to);
  if (a < 0 || b < 0) return [];
  const out = [];
  for (let i = a; ; i = (i + 1) % 7) {
    out.push(DAYS[i]);
    if (i === b || out.length > 7) break;
  }
  return out;
}

/** Collects { day: [[open, close], …] } and turns it into { day: "4–9 PM, …" }. */
class Week {
  constructor() {
    this.ranges = {};
    this.closed = new Set();
    this.conflict = false;
  }

  add(days, open, close) {
    // A range that closes before it opens is a typo on the site ("opens 22:00,
    // closes 21:00"); writing it would state hours the school doesn't keep.
    if (open !== null && close !== null && close <= open) return;
    for (const day of days) {
      if (open === null || close === null) {
        this.closed.add(day);
        continue;
      }
      (this.ranges[day] = this.ranges[day] || []).push([open, close]);
    }
  }

  days() {
    const out = {};
    for (const day of DAYS) {
      const ranges = (this.ranges[day] || []).sort((x, y) => x[0] - y[0]);
      const unique = ranges.filter(
        (r, i) => i === 0 || r[0] !== ranges[i - 1][0] || r[1] !== ranges[i - 1][1],
      );
      if (unique.length) out[day] = unique.map(([o, c]) => formatRange(o, c)).join(', ');
      else if (this.closed.has(day)) out[day] = 'closed';
    }
    return out;
  }
}

// ── schema.org ────────────────────────────────────────────────────────────────

/** "Mo-Fr 16:00-21:00", "Sa 09:00-12:00", "Mo,We,Fr 17:00-20:00", "Mo-Su" (all day). */
function addSchemaLine(week, line) {
  // Each "<days> <open>-<close>" pair; lines without times say nothing about hours.
  const pairs = String(line || '').matchAll(
    /([A-Za-z]{2,9}(?:\s*[-–,]\s*[A-Za-z]{2,9})*)\s+(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/g,
  );
  for (const m of pairs) {
    const days = [];
    for (const piece of m[1].split(/\s*,\s*/)) {
      const [from, to] = piece.split(/\s*[-–]\s*/);
      const a = dayName(from);
      const b = to ? dayName(to) : a;
      if (a && b) days.push(...dayRange(a, b));
    }
    if (!days.length) continue;
    const open = minutes(m[2]);
    const close = minutes(m[3]);
    if (open === null || close === null) continue;
    if (open === 0 && close === 0) week.add(days, null, null);
    else week.add(days, open, close === 0 ? 1440 : close);
  }
}

function addSpecification(week, spec) {
  const list = Array.isArray(spec) ? spec : [spec];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (item.validThrough || item.validFrom) continue; // holiday / seasonal exceptions
    const dayList = Array.isArray(item.dayOfWeek) ? item.dayOfWeek : [item.dayOfWeek];
    const days = dayList.map(dayName).filter(Boolean);
    if (!days.length) continue;
    const open = minutes(String(item.opens || '').slice(0, 5));
    const close = minutes(String(item.closes || '').slice(0, 5));
    if (open === null || close === null) continue;
    if (open === 0 && close === 0) week.add(days, null, null);
    else week.add(days, open, close === 0 ? 1440 : close);
  }
}

function walkSchema(node, week, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  if (Array.isArray(node)) {
    for (const item of node) walkSchema(item, week, depth + 1);
    return;
  }
  if (node.openingHoursSpecification) addSpecification(week, node.openingHoursSpecification);
  if (node.openingHours) {
    for (const line of Array.isArray(node.openingHours) ? node.openingHours : [node.openingHours]) {
      addSchemaLine(week, line);
    }
  }
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'openingHoursSpecification' && value && typeof value === 'object') {
      walkSchema(value, week, depth + 1);
    }
  }
}

function decodeEntities(text) {
  return String(text)
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&ndash;|&#8211;/gi, '–')
    .replace(/&mdash;|&#8212;/gi, '—')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;|&rsquo;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** Hours from the page's structured data, or {} when it has none. */
function schemaHours(html) {
  const week = new Week();
  const scripts = String(html).matchAll(
    /<script[^>]*type=["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi,
  );
  for (const [, body] of scripts) {
    try {
      walkSchema(JSON.parse(body.trim()), week);
    } catch {
      // A broken JSON-LD block is common; the next one may parse.
    }
  }
  for (const m of String(html).matchAll(/<[^>]+itemprop=["']openingHours["'][^>]*>/gi)) {
    const value = (m[0].match(/\b(?:content|datetime)=["']([^"']+)["']/i) || [])[1];
    if (value) addSchemaLine(week, decodeEntities(value));
  }
  return week.days();
}

// ── page text ─────────────────────────────────────────────────────────────────

/** Visible text, one line per block element. */
function pageLines(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(
        /<\/?(?:p|div|li|tr|td|th|h[1-6]|section|article|header|footer|table|ul|ol|dt|dd|span)\b[^>]*>/gi,
        '\n',
      )
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n')
    .map((line) => line.replace(/[\u00a0\u2009\u202f\t ]+/g, ' ').trim())
    .filter(Boolean);
}

const HOURS_HEADING =
  /\b(?:hours(?: of operation)?|opening times|office hours|business hours|front desk hours|studio hours|gym hours|open hours)\b/i;
const DAY_WORD =
  '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\\.?';
const DAY_SPEC = new RegExp(
  `^(${DAY_WORD}(?:\\s*(?:-|–|—|to|thru|through|&|and|,)\\s*${DAY_WORD})*|daily|every ?day|7 days(?: a week)?|weekdays|weekends)\\s*:?\\s*`,
  'i',
);
const TIME_WORD = '(?:\\d{1,2}(?::\\d{2})?\\s*(?:[ap]\\.?m\\.?)?|noon|midnight)';
const RANGE_RE = new RegExp(`(${TIME_WORD})\\s*(?:-|–|—|to|until)\\s*(${TIME_WORD})`, 'gi');

function daysFromSpec(spec) {
  const s = spec.toLowerCase().replace(/\./g, '').trim();
  if (/^(daily|every ?day|7 days)/.test(s)) return [...DAYS];
  if (s === 'weekdays') return DAYS.slice(0, 5);
  if (s === 'weekends') return DAYS.slice(5);
  const days = [];
  for (const piece of s.split(/\s*(?:,|&|and)\s*/)) {
    const [from, to] = piece.split(/\s*(?:-|–|—|to|thru|through)\s*/);
    const a = dayName(from);
    const b = to ? dayName(to) : a;
    if (a && b) days.push(...dayRange(a, b));
  }
  return days;
}

/**
 * "4:00pm - 9:00pm, 6-8 am" -> [[960, 1260], [360, 480]]; null when a range is
 * unreadable. A range with no am/pm at all counts only as 24-hour time
 * ("16:00-21:00"); "5:30-6:30" could be morning or evening and is not guessed.
 */
function rangesFrom(text) {
  const out = [];
  for (const m of text.matchAll(RANGE_RE)) {
    const own = (part) => (part.match(/[ap](?=\.?\s*m|$)/i) || [''])[0].toLowerCase();
    const word = /noon|midnight/i;
    const a = own(m[1]);
    const b = own(m[2]);
    if (!a && !b && !word.test(m[1] + m[2])) {
      const hours = [m[1], m[2]].map((part) => Number(part.match(/\d+/)[0]));
      if (!hours.some((h) => h > 12)) return null;
    }
    const close = minutes(m[2], b || a);
    let open = minutes(m[1], a || b);
    if (open !== null && close !== null && !a && b && open >= close) {
      // "11-2pm": the opening time is in the other half of the day.
      open = minutes(m[1], b === 'p' ? 'a' : 'p');
    }
    if (open === null || close === null) return null;
    const end = close === 0 ? 1440 : close;
    if (end <= open) return null;
    out.push([open, end]);
  }
  return out;
}

/**
 * Hours from an "Hours" block in the page text: the lines right after a heading
 * like "Hours", "Office hours" or "Hours of operation". A block that names the
 * same day twice with different times is a class schedule, not opening hours,
 * and is not used.
 */
function textHours(html) {
  const lines = pageLines(html);
  for (let i = 0; i < lines.length; i += 1) {
    if (!HOURS_HEADING.test(lines[i]) || lines[i].length > 80) continue;
    const heading = lines[i].match(HOURS_HEADING);
    const rest = lines[i].slice(heading.index + heading[0].length).replace(/^\s*[:\-–]?\s*/, '');
    // "Mon-Fri 4-9pm, Sat 9am-12pm | Sun closed" on one line: one entry per day group.
    const window = [rest, ...lines.slice(i + 1, i + 14)].flatMap((line) =>
      line.split(/\s*[|;•]\s*|,\s*(?=(?:mon|tue|wed|thu|fri|sat|sun|daily|weekdays|weekends)\b)/i),
    );
    const seen = {};
    const week = new Week();
    let entries = 0;
    let conflict = false;
    let pendingDays = null;
    for (const raw of window) {
      let line = raw.trim();
      if (!line) continue;
      const spec = line.match(DAY_SPEC);
      let days = null;
      if (spec && spec[1]) {
        days = daysFromSpec(spec[1]);
        line = line.slice(spec[0].length);
      }
      if (!days || !days.length) {
        if (!pendingDays) continue;
        days = pendingDays;
      }
      pendingDays = null;
      if (/^closed\b/i.test(line)) {
        for (const day of days) {
          if (seen[day] && seen[day] !== 'closed') conflict = true;
          seen[day] = 'closed';
        }
        week.add(days, null, null);
        entries += 1;
        continue;
      }
      const ranges = rangesFrom(line);
      if (ranges === null) continue;
      if (!ranges.length) {
        // "Monday - Friday" on one line, the times on the next.
        if (!line) pendingDays = days;
        continue;
      }
      const key = JSON.stringify(ranges);
      for (const day of days) {
        if (seen[day] && seen[day] !== key) conflict = true;
        seen[day] = key;
      }
      for (const [open, close] of ranges) week.add(days, open, close);
      entries += 1;
    }
    const result = week.days();
    if (!conflict && Object.keys(result).length >= 3 && entries >= 1) return result;
  }
  return {};
}

/** The best hours a page gives: structured data first, then the page text. */
function pageHours(html) {
  const fromSchema = schemaHours(html);
  if (Object.keys(fromSchema).length >= 3) return { days: fromSchema, source: 'schema' };
  const fromText = textHours(html);
  if (Object.keys(fromText).length >= 3) return { days: fromText, source: 'text' };
  return { days: {}, source: '' };
}

// ── fetching ──────────────────────────────────────────────────────────────────

const NOT_A_SCHOOL_SITE =
  /(?:^|\.)(?:facebook|instagram|twitter|x|linkedin|youtube|tiktok|yelp|google|linktr|wixsite-placeholder|mindbodyonline|groupon|nextdoor)\.[a-z.]+$/i;
const PRIVATE_HOST =
  /^(?:localhost|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?$)/i;
const SUBPAGE_HINT = /contact|hours|location|visit|about|schedule|find-us|directions/i;
const MAX_BYTES = 2_000_000;

async function getHtml(url, fetchImpl, timeoutMs) {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) return null;
  const type = res.headers.get('content-type') || '';
  if (type && !/html|xml/i.test(type)) return null;
  const text = await res.text();
  return { html: text.slice(0, MAX_BYTES), url: res.url || url };
}

/** Same-site links that may carry the hours (contact, about, location …), at most `limit`. */
function subpages(html, base, limit) {
  const out = [];
  let origin;
  try {
    origin = new URL(base);
  } catch {
    return out;
  }
  for (const m of String(html).matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = m[2].replace(/<[^>]+>/g, ' ');
    if (!SUBPAGE_HINT.test(m[1]) && !SUBPAGE_HINT.test(label)) continue;
    let url;
    try {
      url = new URL(m[1], origin);
    } catch {
      continue;
    }
    if (url.hostname.replace(/^www\./, '') !== origin.hostname.replace(/^www\./, '')) continue;
    url.hash = '';
    const href = url.toString();
    if (href !== origin.toString() && !out.includes(href)) out.push(href);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Opening hours from a school's own website, as one formatted line ("" when the
 * site doesn't say). Reads the homepage, then up to two contact/about/location
 * pages it links to.
 */
async function websiteHours(
  websiteUrl,
  { fetchImpl = fetch, timeoutMs = 15_000, extraPages = 2 } = {},
) {
  let start;
  try {
    start = new URL(String(websiteUrl || '').trim());
  } catch {
    return { hours: '', source: '' };
  }
  if (!/^https?:$/.test(start.protocol)) return { hours: '', source: '' };
  if (NOT_A_SCHOOL_SITE.test(start.hostname) || PRIVATE_HOST.test(start.hostname)) {
    return { hours: '', source: '' };
  }
  const home = await getHtml(start.toString(), fetchImpl, timeoutMs).catch(() => null);
  if (!home) return { hours: '', source: '' };
  let found = pageHours(home.html);
  if (found.source) return { hours: formatWeek(found.days), source: `${found.source}:${home.url}` };
  for (const url of subpages(home.html, home.url, extraPages)) {
    const page = await getHtml(url, fetchImpl, timeoutMs).catch(() => null);
    if (!page) continue;
    found = pageHours(page.html);
    if (found.source)
      return { hours: formatWeek(found.days), source: `${found.source}:${page.url}` };
  }
  return { hours: '', source: '' };
}

/** Runs fn over items, at most `limit` at a time. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = {
  DAYS,
  daysCovered,
  formatRange,
  formatWeek,
  mapLimit,
  minutes,
  pageHours,
  schemaHours,
  textHours,
  websiteHours,
};
