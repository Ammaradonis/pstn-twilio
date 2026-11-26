#!/usr/bin/env node
'use strict';
/**
 * Weekly refresh of the U.S. Conquest workbook from Google Maps, using the
 * scraper in MAPS_SCRAPER_DIR (default C:\Users\FingerWeg\CascadeProjects\real-google-maps-scraper).
 *
 * Every week, state by state in the order of all-us-counties.txt:
 *   1. Jobs: one "martial arts schools in <County>, <State>, USA" search per county
 *      listed in all-us-counties.txt, anchored on the county; map tiles where the
 *      sheet's places are dense; finer tiles where last week's lists were cut off.
 *   2. Scrape: the scraper's own CLI (cliV2.js --strict-validation) in a fresh data
 *      folder, so no cached place answers for this week.
 *   3. Sync: column G of every row whose place now lists another phone number gets
 *      the new number; websiteUrl gets the website Maps lists now; openingTimes
 *      gets the hours from the school's Business Profile on Maps (or, when Maps
 *      lists none, from its own website). Martial arts places that are in no tab
 *      of the workbook are added at the bottom of the tab for the state in their
 *      address.
 * The UK workbook is not touched.
 *
 * Commands (run from the repo root):
 *   node workers/maps-refresh/refresh.cjs run           this week's run: starts it, or resumes it
 *   node workers/maps-refresh/refresh.cjs state TX      one state now, outside the weekly bookkeeping
 *   node workers/maps-refresh/refresh.cjs sync TX --from <scrape folder>   sync a finished scrape
 *   node workers/maps-refresh/refresh.cjs status
 *   node workers/maps-refresh/refresh.cjs columns       add the openingTimes column to every state tab
 * Add --dry-run to state/sync to write the plan (sync-plan.json) without touching the sheet.
 *
 * The scheduled task "BestSoftphone Maps Refresh" (install-task.ps1) calls `run`
 * at logon and every hour; a run that is already going, or this week's finished
 * run, makes that a no-op.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

const hoursLib = require('./hours.cjs');
const lib = require('./lib.cjs');
const { SheetsClient } = require('./sheets.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const SCRAPER_DIR =
  process.env.MAPS_SCRAPER_DIR || 'C:\\Users\\FingerWeg\\CascadeProjects\\real-google-maps-scraper';
const WORK_DIR = process.env.MAPS_REFRESH_DIR || path.join(REPO, '.cache', 'maps-refresh');
const SHEET_ID = process.env.US_CONQUEST_SHEET_ID || '1hEen_n9M27n5bjyXpsnaHXpvG7S5eHHmPl6HG2LhRnM';
const CREDENTIALS = process.env.GOOGLE_SERVICE_ACCOUNT_FILE || path.join(REPO, 'gcp-creds.json');
const QUERY = 'martial arts schools';
const WORKERS = Number(process.env.MAPS_REFRESH_WORKERS || 3);
// Tries per state per week before it is skipped until next week.
const MAX_ATTEMPTS = 4;
// After a failed scrape (usually Google pushing back) the run waits 1 h, 2 h, 4 h … up to a day.
const MAX_BACKOFF_MS = 24 * 3600_000;
// A running refresh renews its lock every 10 minutes; one not renewed for this
// long belongs to a crashed run, even if Windows has reused its process id.
const LOCK_STALE_MS = 2 * 3600_000;
const STATE_FILE = path.join(WORK_DIR, 'state.json');
const LOCK_FILE = path.join(WORK_DIR, 'refresh.lock');
const LOG_FILE = path.join(WORK_DIR, 'refresh.log');
const ADDED_FILE = path.join(WORK_DIR, 'added-places.json');
// School websites read at once when Maps lists no hours (plain HTTP, no browser).
const WEBSITE_HOURS_CONCURRENCY = Number(process.env.MAPS_REFRESH_WEBSITE_CONCURRENCY || 6);

function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  console.info(line);
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // The console copy is enough if the log can't be written.
  }
}

function scraper() {
  const load = createRequire(path.join(SCRAPER_DIR, 'package.json'));
  return {
    geo: load('./lib/countyGeo'),
    jobs: load('./scripts/buildJobs'),
    geography: load('./validation/geographicValidator'),
    placeId: load('./lib/placeCache').placeIdFromUrl,
    parseCsv: load('csv-parse/sync').parse,
  };
}

function sheetsClient() {
  return new SheetsClient({ credentialsFile: CREDENTIALS, spreadsheetId: SHEET_ID });
}

function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { runs: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  writeJson(STATE_FILE, state);
}

function loadAddedPlaces() {
  try {
    return JSON.parse(fs.readFileSync(ADDED_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveAddedPlaces(ledger) {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  writeJson(ADDED_FILE, ledger);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function acquireLock() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  try {
    fs.writeFileSync(
      LOCK_FILE,
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
      {
        flag: 'wx',
      },
    );
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    } catch {
      // Unreadable lock: treat as stale.
    }
    const fresh = holder && Date.now() - Date.parse(holder.at) < LOCK_STALE_MS;
    if (holder && fresh && processAlive(holder.pid)) return false;
    fs.rmSync(LOCK_FILE, { force: true });
    return acquireLock();
  }
  // A pass over all states can outlast LOCK_STALE_MS, so the lock is renewed while it runs.
  setInterval(() => {
    try {
      writeJson(LOCK_FILE, { pid: process.pid, at: new Date().toISOString() });
    } catch {
      // Next beat.
    }
  }, 10 * 60_000).unref();
  process.on('exit', () => {
    try {
      const holder = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (holder.pid === process.pid) fs.rmSync(LOCK_FILE, { force: true });
    } catch {
      // Already gone.
    }
  });
  return true;
}

function counties() {
  return lib.parseCountiesFile(
    fs.readFileSync(path.join(SCRAPER_DIR, 'all-us-counties.txt'), 'utf8'),
  );
}

/** The workbook's state tabs (the Meta ads tabs and anything else are left out). */
async function readStateTabs(sheets) {
  const titles = (await sheets.tabTitles()).filter((title) => lib.stateAbbrev(title));
  return sheets.readTabs(titles);
}

/**
 * Gives every state tab an openingTimes column, after the last column any row
 * uses (so nothing moves and no value is covered), widening the grid if needed.
 * The tabs passed in get the header too, so a plan made from them sees it.
 */
async function ensureHoursColumns(sheets, tabs, { dryRun = false } = {}) {
  const props = new Map((await sheets.tabProps()).map((p) => [p.title, p]));
  const added = [];
  for (const tab of tabs) {
    const col = lib.hoursColumnFor(tab);
    if (col < 0) continue;
    const grid = props.get(tab.title);
    if (!dryRun) {
      if (grid && col >= grid.columnCount)
        await sheets.appendColumns(grid.sheetId, col + 1 - grid.columnCount);
      await sheets.writeCells([
        { range: lib.a1(tab.title, `${lib.columnLetter(col)}1`), value: lib.HOURS_HEADER },
      ]);
    }
    while (tab.headers.length < col) tab.headers.push('');
    tab.headers[col] = lib.HOURS_HEADER;
    added.push(`${tab.title} ${lib.columnLetter(col)}`);
  }
  if (added.length) {
    log(`${dryRun ? 'Would add' : 'Added'} the ${lib.HOURS_HEADER} column: ${added.join(', ')}`);
  }
  return added;
}

/**
 * Hours from the schools' own websites for the places Maps lists none for.
 * Answers (including "none found") are kept in the state's folder, so a resumed
 * sync doesn't read the same sites again.
 */
async function lookUpWebsiteHours(dir, wanted) {
  const file = path.join(dir, 'website-hours.json');
  let cache = {};
  try {
    cache = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // First lookup for this state.
  }
  const todo = wanted.filter((w) => !(w.placeId in cache));
  if (todo.length) {
    log(`Reading ${todo.length} school websites for opening hours (Maps lists none for them)`);
    let done = 0;
    await hoursLib.mapLimit(todo, WEBSITE_HOURS_CONCURRENCY, async ({ placeId, websiteUrl }) => {
      const found = await hoursLib
        .websiteHours(websiteUrl)
        .catch(() => ({ hours: '', source: '' }));
      cache[placeId] = {
        url: websiteUrl,
        hours: found.hours,
        source: found.source,
        at: new Date().toISOString(),
      };
      done += 1;
      if (done % 50 === 0) writeJson(file, cache);
    });
    writeJson(file, cache);
    const hits = todo.filter((w) => cache[w.placeId].hours).length;
    log(`Websites gave opening hours for ${hits} of ${todo.length} schools`);
  }
  return new Map(Object.entries(cache).map(([id, entry]) => [id, entry.hours || '']));
}

function placeColumn(tab) {
  return tab.headers.map((h) => String(h).trim().toLowerCase()).indexOf('placeurl');
}

/** Search URLs for one state: every county in all-us-counties.txt, plus tiles. */
function buildStateJobs(entry, tabs, previousDir) {
  const { geo, jobs, geography } = scraper();
  const known = geo.countiesInState(entry.abbr);
  const urls = [];
  const unanchored = [];
  for (const name of entry.counties) {
    const county = lib.matchCounty(name, known);
    if (county) {
      urls.push(jobs.searchUrl(QUERY, county, county.lat, county.lng, geo.zoomForCounty(county)));
    } else {
      unanchored.push(name);
      urls.push(lib.unanchoredSearchUrl(QUERY, name, entry.state));
    }
  }

  // Where the sheet already lists many places, county lists get cut off at ~120:
  // smaller map-tile searches cover those areas.
  const tab = tabs.find((t) => lib.stateAbbrev(t.title) === entry.abbr);
  const col = tab ? placeColumn(tab) : -1;
  const coords =
    tab && col >= 0
      ? tab.rows
          .map((row) => geography.coordinatesFromPlaceUrl(row[col] || ''))
          .filter((c) => c && geography.coordinatesInState(c, entry.abbr))
      : [];
  const { tileJobs } = jobs.buildJobs({
    state: entry.abbr,
    query: QUERY,
    knownCoords: coords,
    tileMinPlaces: 5,
  });

  let refined = [];
  if (previousDir && fs.existsSync(path.join(previousDir, 'queue-state.json'))) {
    try {
      refined = jobs.refineJobs({ state: entry.abbr, query: QUERY, dataDir: previousDir }).jobs;
    } catch (err) {
      log(`${entry.abbr}: could not read last week's cut-off searches: ${err.message}`);
    }
  }
  return {
    urls: [...new Set([...urls, ...tileJobs, ...refined])],
    counties: entry.counties.length,
    unanchored,
    tiles: tileJobs.length,
    refined: refined.length,
  };
}

function runScraper(jobsFile, dir) {
  return new Promise((resolve, reject) => {
    const logFd = fs.openSync(path.join(dir, 'scraper.log'), 'a');
    const child = spawn(
      process.execPath,
      [
        path.join(SCRAPER_DIR, 'cliV2.js'),
        '--jobs',
        jobsFile,
        '--workers',
        String(WORKERS),
        '--resume',
        '--strict-validation',
        '--dataDir',
        dir,
      ],
      {
        cwd: SCRAPER_DIR,
        // The production profile: 9-13 s between a worker's searches, longer backoff when blocked.
        // Panels whose opening hours can't be read are sampled to hours-misses.jsonl.
        env: {
          ...process.env,
          NODE_ENV: 'production',
          MAPS_HOURS_DEBUG_FILE: path.join(dir, 'hours-misses.jsonl'),
        },
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      },
    );
    child.on('error', (err) => {
      fs.closeSync(logFd);
      reject(err);
    });
    child.on('exit', (code) => {
      fs.closeSync(logFd);
      if (code === 0) resolve();
      else
        reject(new Error(`scraper exited with code ${code}; see ${path.join(dir, 'scraper.log')}`));
    });
  });
}

function csvLine(values) {
  return values.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',');
}

function lastFilledRow(tab) {
  for (let i = tab.rows.length - 1; i >= 0; i -= 1) {
    if ((tab.rows[i] || []).some((cell) => String(cell).trim() !== '')) return i + 2;
  }
  return 1;
}

/** Applies one state's scrape (dir/out/master.csv) to the workbook. */
async function syncState(abbr, dir, { dryRun = false } = {}) {
  const { placeId, parseCsv } = scraper();
  const master = path.join(dir, 'out', 'master.csv');
  if (!fs.existsSync(master)) throw new Error(`No scrape results at ${master}`);
  const scraped = parseCsv(fs.readFileSync(master, 'utf8'), {
    columns: true,
    skip_empty_lines: true,
  });

  const sheets = sheetsClient();
  const tabs = await readStateTabs(sheets);
  await ensureHoursColumns(sheets, tabs, { dryRun });
  let plan = lib.planSync({ tabs, scraped, placeId, fallbackState: abbr });
  if (plan.wantHours.length) {
    const websiteHours = await lookUpWebsiteHours(dir, plan.wantHours);
    plan = lib.planSync({ tabs, scraped, placeId, fallbackState: abbr, websiteHours });
  }
  writeJson(path.join(dir, 'sync-plan.json'), plan);
  if (dryRun) {
    log(`${abbr}: dry run, nothing written. ${JSON.stringify(plan.stats)}`);
    return { ...plan.stats, dryRun: true };
  }

  // Re-read right before writing: a row someone moved or edited since the plan
  // was made is left alone rather than given another place's number.
  const affected = [
    ...new Set([...plan.updates.map((u) => u.tab), ...plan.cellUpdates.map((u) => u.tab)]),
  ];
  const current = new Map((await sheets.readTabs(affected)).map((tab) => [tab.title, tab]));
  const cells = [];
  const changes = [];
  let changedMeanwhile = 0;
  for (const update of plan.updates) {
    const tab = current.get(update.tab);
    const row = tab ? tab.rows[update.row - 2] || [] : [];
    const col = tab ? placeColumn(tab) : -1;
    if (
      col < 0 ||
      placeId(row[col] || '') !== update.placeId ||
      (row[lib.PHONE_COL] || '') !== update.oldPhone
    ) {
      changedMeanwhile += 1;
      continue;
    }
    cells.push({ range: lib.a1(update.tab, `G${update.row}`), value: update.newPhone });
    changes.push([update.tab, update.row, update.title, update.oldPhone, update.newPhone]);
  }

  // websiteUrl and openingTimes: the same check, and the column is found again by
  // its header in case one was inserted meanwhile.
  const fieldChanges = [];
  const written = { websiteUrl: 0, [lib.HOURS_HEADER]: 0, hoursFromWebsite: 0 };
  for (const update of plan.cellUpdates) {
    const tab = current.get(update.tab);
    const row = tab ? tab.rows[update.row - 2] || [] : [];
    const headers = tab ? tab.headers.map((h) => String(h).trim().toLowerCase()) : [];
    const col = headers.indexOf(update.field.toLowerCase());
    const placeCol = tab ? placeColumn(tab) : -1;
    if (
      col < 0 ||
      placeCol < 0 ||
      placeId(row[placeCol] || '') !== update.placeId ||
      String(row[col] ?? '').trim() !== update.old
    ) {
      changedMeanwhile += 1;
      continue;
    }
    cells.push({
      range: lib.a1(update.tab, `${lib.columnLetter(col)}${update.row}`),
      value: update.value,
    });
    fieldChanges.push([
      update.tab,
      update.row,
      update.title,
      update.field,
      update.source,
      update.old,
      update.value,
    ]);
    written[update.field] += 1;
    if (update.source === 'website') written.hoursFromWebsite += 1;
  }
  await sheets.writeCells(cells);

  // Every place this refresh has ever added: one you delete from the sheet stays deleted.
  const ledger = loadAddedPlaces();
  let added = 0;
  let deletedBefore = 0;
  const addedLines = [];
  for (const [title, rows] of Object.entries(plan.appends)) {
    const [tab] = await sheets.readTabs([title]);
    const col = placeColumn(tab);
    const present = new Set(tab.rows.map((row) => (col >= 0 ? placeId(row[col] || '') : '')));
    const fresh = rows.filter((r) => {
      if (present.has(r.placeId)) return false;
      if (ledger[r.placeId]) {
        deletedBefore += 1;
        return false;
      }
      return true;
    });
    if (fresh.length === 0) continue;
    await sheets.appendRows(
      title,
      fresh.map((r) => r.values),
      lastFilledRow(tab),
    );
    const at = new Date().toISOString();
    for (const r of fresh) ledger[r.placeId] = { tab: title, title: r.title, at };
    saveAddedPlaces(ledger);
    added += fresh.length;
    for (const r of fresh) addedLines.push([title, r.title, r.placeId]);
  }

  const stamp = new Date().toISOString();
  if (fieldChanges.length) {
    fs.appendFileSync(
      path.join(dir, 'field-changes.csv'),
      fieldChanges.map((c) => csvLine([stamp, ...c])).join('\n') + '\n',
    );
  }
  if (changes.length) {
    fs.appendFileSync(
      path.join(dir, 'phone-changes.csv'),
      changes.map((c) => csvLine([stamp, ...c])).join('\n') + '\n',
    );
  }
  if (addedLines.length) {
    fs.appendFileSync(
      path.join(dir, 'added.csv'),
      addedLines.map((c) => csvLine([stamp, ...c])).join('\n') + '\n',
    );
  }
  const result = {
    ...plan.stats,
    phoneUpdates: changes.length,
    websiteUpdates: written.websiteUrl,
    hoursUpdates: written[lib.HOURS_HEADER],
    hoursFromWebsite: written.hoursFromWebsite,
    added,
    changedMeanwhile,
    deletedBefore,
  };
  log(
    `${abbr}: ${changes.length} phone numbers, ${written.websiteUrl} websites and ` +
      `${written[lib.HOURS_HEADER]} opening times updated (${written.hoursFromWebsite} from school websites), ` +
      `${added} new schools added` +
      (changedMeanwhile ? `, ${changedMeanwhile} rows skipped (edited while syncing)` : '') +
      ` (${plan.stats.scraped} places scraped, ${plan.stats.matched} already listed)`,
  );
  return result;
}

/** Jobs, scrape and sync for one state, resuming whichever step was interrupted. */
async function refreshState(entry, { dir, previousDir = null, dryRun = false }) {
  fs.mkdirSync(dir, { recursive: true });
  const jobsFile = path.join(dir, 'jobs.txt');
  if (!fs.existsSync(jobsFile)) {
    const tabs = await readStateTabs(sheetsClient());
    const built = buildStateJobs(entry, tabs, previousDir);
    fs.writeFileSync(jobsFile, `${built.urls.join('\n')}\n`);
    log(
      `${entry.abbr}: ${built.urls.length} searches (${built.counties} counties, ${built.tiles} tiles, ` +
        `${built.refined} finer tiles)` +
        (built.unanchored.length
          ? `; no census match, searched by name: ${built.unanchored.join(', ')}`
          : ''),
    );
  }
  const scrapedMarker = path.join(dir, 'scraped.json');
  if (!fs.existsSync(scrapedMarker)) {
    log(`${entry.abbr}: scraping`);
    await runScraper(jobsFile, dir);
    writeJson(scrapedMarker, { at: new Date().toISOString() });
  }
  return syncState(entry.abbr, dir, { dryRun });
}

function weekDirs() {
  if (!fs.existsSync(WORK_DIR)) return [];
  return fs
    .readdirSync(WORK_DIR)
    .filter((name) => /^\d{4}-W\d{2}$/.test(name))
    .sort();
}

async function runWeekly(now = new Date()) {
  const state = loadState();
  const week = lib.weekId(now);
  let run = state.runs[state.runs.length - 1];
  if (!run || (run.finishedAt && run.week !== week)) {
    run = { week, startedAt: now.toISOString(), states: {}, failures: 0 };
    state.runs.push(run);
    state.runs = state.runs.slice(-12);
    saveState(state);
    log(`Week ${week}: refresh started`);
  } else if (run.finishedAt) {
    return;
  }
  if (run.retryAfter && Date.parse(run.retryAfter) > now.getTime()) return;

  const previous = state.runs.length > 1 ? state.runs[state.runs.length - 2] : null;
  for (const entry of counties()) {
    const progress = (run.states[entry.abbr] = run.states[entry.abbr] || { attempts: 0 });
    if (progress.status === 'done' || progress.status === 'failed') continue;
    progress.attempts += 1;
    saveState(state);
    try {
      const result = await refreshState(entry, {
        dir: path.join(WORK_DIR, run.week, entry.abbr),
        previousDir: previous ? path.join(WORK_DIR, previous.week, entry.abbr) : null,
      });
      Object.assign(progress, { status: 'done', finishedAt: new Date().toISOString(), result });
      delete progress.error;
      run.failures = 0;
      delete run.retryAfter;
      saveState(state);
    } catch (err) {
      progress.error = err.message;
      run.failures = (run.failures || 0) + 1;
      const wait = Math.min(MAX_BACKOFF_MS, 3600_000 * 2 ** (run.failures - 1));
      run.retryAfter = new Date(Date.now() + wait).toISOString();
      if (progress.attempts >= MAX_ATTEMPTS) {
        progress.status = 'failed';
        log(
          `${entry.abbr}: gave up for this week after ${progress.attempts} tries: ${err.message}`,
        );
      } else {
        log(
          `${entry.abbr}: failed (try ${progress.attempts}): ${err.message}. Resuming after ${run.retryAfter}`,
        );
      }
      saveState(state);
      return;
    }
  }

  run.finishedAt = new Date().toISOString();
  saveState(state);
  const done = Object.values(run.states);
  const total = (key) => done.reduce((sum, s) => sum + Number(s.result?.[key] || 0), 0);
  log(
    `Week ${run.week}: refresh finished. ${total('phoneUpdates')} phone numbers, ` +
      `${total('websiteUpdates')} websites and ${total('hoursUpdates')} opening times updated, ` +
      `${total('added')} schools added, ${done.filter((s) => s.status === 'failed').length} states skipped`,
  );
  // Keep this run and the one before (its cut-off searches feed the next run's tiles).
  const keep = new Set(state.runs.slice(-2).map((r) => r.week));
  for (const name of weekDirs()) {
    if (!keep.has(name)) fs.rmSync(path.join(WORK_DIR, name), { recursive: true, force: true });
  }
}

function printStatus() {
  const state = loadState();
  const run = state.runs[state.runs.length - 1];
  if (!run) {
    console.info('No refresh has run yet.');
    return;
  }
  const entries = Object.entries(run.states);
  const done = entries.filter(([, s]) => s.status === 'done');
  console.info(
    `Week ${run.week}: started ${run.startedAt}${run.finishedAt ? `, finished ${run.finishedAt}` : ''}. ` +
      `${done.length}/50 states done.` +
      (run.retryAfter ? ` Waiting until ${run.retryAfter} after a failure.` : ''),
  );
  for (const [abbr, s] of entries) {
    const r = s.result || {};
    console.info(
      `  ${abbr}: ${s.status || 'in progress'}` +
        (s.status === 'done'
          ? `, ${r.phoneUpdates} phones, ${r.websiteUpdates ?? 0} websites, ` +
            `${r.hoursUpdates ?? 0} opening times updated, ${r.added} added`
          : '') +
        (s.error ? `, last error: ${s.error}` : ''),
    );
  }
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv) {
  const [command = 'run', arg] = argv;
  const dryRun = argv.includes('--dry-run');
  if (command === 'status') return printStatus();

  if (command === 'columns') {
    // Header cells only: safe next to a running refresh.
    const sheets = sheetsClient();
    const added = await ensureHoursColumns(sheets, await readStateTabs(sheets), { dryRun });
    console.info(added.length ? added.join('\n') : 'Every state tab already has openingTimes.');
    return;
  }

  if (!acquireLock()) {
    if (command !== 'run') throw new Error('A refresh is already running; try again when it ends.');
    return;
  }
  if (command === 'run') return runWeekly();

  const abbr = lib.stateAbbrev(arg || '');
  if (!abbr) throw new Error('Name a state, e.g. TX or Texas.');
  if (command === 'state') {
    const entry = counties().find((e) => e.abbr === abbr);
    const dir = flag(argv, '--dir') || path.join(WORK_DIR, 'manual', abbr);
    const result = await refreshState(entry, { dir: path.resolve(dir), dryRun });
    console.info(JSON.stringify(result, null, 2));
    return;
  }
  if (command === 'sync') {
    const from = flag(argv, '--from');
    if (!from) throw new Error('sync needs --from <scrape folder>');
    const result = await syncState(abbr, path.resolve(from), { dryRun });
    console.info(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error(`Unknown command "${command}"`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    log(`Error: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { buildStateJobs, syncState, runWeekly };
