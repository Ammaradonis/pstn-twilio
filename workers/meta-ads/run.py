"""Four bounded-queue workers: scroll, extract, match, verify/export.

Run from any directory with the email-finder virtualenv. No spreadsheet writes
occur here; the Sheets bridge applies verified evidence with fresh row checks.
Verified matches are also uploaded to the app (`remote.py`) so the Dial page's
"Meta ad filter" button can copy the matching rows into a new tab.
"""
import argparse
import asyncio
import csv
import json
import msvcrt
import os
import re
import sqlite3
import shutil
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit, parse_qs

from matching import (name_key, facebook_key, qualifies, has_own_page, is_evidence, match_kind)
from remote import evidence_rows, upload

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.cache/meta-ads'
sys.path.insert(0, str(ROOT / 'workers/email-finder'))
from email_finder.cookies import import_once, FACEBOOK_HOSTS
from playwright.async_api import async_playwright, Error as PlaywrightError, TimeoutError as PlaywrightTimeout

SEEDS = ['martial arts', 'karate', 'taekwondo', 'jiu jitsu', 'kickboxing', 'kung fu', 'judo', 'aikido', 'self defense']

# A page state only the user can clear (a login wall, a checkpoint, a block, or
# cards this extractor does not recognize). These end the pass on purpose; a
# timeout or a dropped connection does not, and is handled per query.
STOP_TEXT = ['temporarily blocked', 'you’re temporarily blocked', 'too many requests', 'confirm you are human']

# Meta's "no ads" wording, old and new ("0 results" since late 2026).
NO_RESULTS_TEXT = ['No ads match', 'No results found']
RESULTS_LINE = re.compile(r'^\s*[~>]?\s*([\d,.]+)\s*(K|M)?\s+results?\s*$', re.I | re.M)

# The results draw well after domcontentloaded on this PC (8-25 s with the other
# workers running). The pass used to read the page after a fixed 5 s, take the
# empty grid for a layout it did not know, and stop for good on the very first
# search (25 Oct): no search ever finished and the filter's evidence aged out.
RENDER_WAIT_MS = 45000
# Several unreadable pages in a row mean the layout really changed; one is a slow page.
MAX_UNRECOGNIZED_IN_A_ROW = 3

# A finished search is due again after this many days, so "still advertising
# now" (ads seen in the last 30 days) stays true for schools that still are.
REFRESH_DAYS = 21
DONE = ('stalled', 'no_results', 'capped')
# Scroll caps. The keyword seeds return >50,000 ads: scrolling them out grows one
# page past what this 4 GB PC can hold. A school name returns a handful.
DISCOVERY_SCROLLS = 40
SCHOOL_SCROLLS = 25


class StopScrape(RuntimeError):
    """Facebook needs the user; continuing would make it worse."""


def result_count(body: str) -> int | None:
    """The '~1,200 results' line Meta prints above the cards, as a number."""
    match = RESULTS_LINE.search(body)
    if not match:
        return None
    value = float(match.group(1).replace(',', ''))
    return int(value * {'K': 1000, 'M': 1000000}.get((match.group(2) or '').upper(), 1))


def is_due(prior: tuple | None, refresh: bool, refresh_days: float, now_ts: float | None = None) -> bool:
    """Whether a search should run: new, unfinished, or finished long enough ago."""
    if prior is None or refresh:
        return True
    status, observed = prior
    if status not in DONE:
        return True
    try:
        age = (now_ts or time.time()) - datetime.fromisoformat(observed).timestamp()
    except (TypeError, ValueError):
        return True
    return age >= refresh_days * 86400


async def body_text(page) -> str:
    """The page's visible text, retried.

    The read gets a 15-second timeout and three tries. Its 30-second default
    raised on a slow ads-library page, and one raised read ended a pass that had
    hours of evidence behind it (23 Oct).
    """
    for attempt in range(3):
        try:
            return await page.locator('body').inner_text(timeout=15000)
        except PlaywrightTimeout:
            if attempt == 2:
                raise
            await page.wait_for_timeout(3000)
    raise AssertionError('unreachable')


def now():
    return datetime.now(timezone.utc).isoformat()


class Pipeline:
    def __init__(self, args):
        self.args = args
        OUT.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(OUT / 'ads.sqlite')
        self.db.executescript('''
            CREATE TABLE IF NOT EXISTS ads(country TEXT, id TEXT, data TEXT, PRIMARY KEY(country,id));
            CREATE TABLE IF NOT EXISTS searches(country TEXT, query TEXT, status TEXT, observed_at TEXT, PRIMARY KEY(country,query));
        ''')
        self.inventory = json.loads((OUT / 'inventory.json').read_text(encoding='utf-8'))
        self.names, self.urls = defaultdict(list), defaultdict(list)
        for lead in self.inventory['leads']:
            self.names[(lead['country'], name_key(lead['title']))].append(lead)
            key = facebook_key(lead['facebookUrl'])
            if key:
                self.urls[(lead['country'], key)].append(lead)
        self.snapshots, self.ads, self.candidates = (asyncio.Queue(2), asyncio.Queue(100), asyncio.Queue(100))
        self.results = {}
        self.last_apply = 0
        self.last_export = 0
        self.applied_count = 0
        # Matches uploaded to the app for the Dial page's Meta ad filter.
        self.synced = 0
        self.last_sync = 0.0
        self.sync_state = 'disabled' if args.no_sync else 'idle'
        self.sync_note = None
        self.apply_state = 'idle' if args.apply else 'disabled'
        self.apply_note = None
        self.counts = {'ads': 0, 'prospects': 0, 'verified': 0, 'evidence': 0, 'searches': 0,
                       'synced': 0}

    def status(self, state, **extra):
        (OUT / 'status.json').write_text(json.dumps({'state': state, 'updatedAt': now(), **self.counts,
                                                     'sync': {'state': self.sync_state, 'note': self.sync_note, 'synced': self.synced},
                                                     'apply': {'state': self.apply_state, 'note': self.apply_note},
                                                     **extra}, indent=2), encoding='utf-8')

    async def query_reason(self, page, country, query, extractor, cap=0):
        """One library search: (why it stopped, cards seen).

        A transient page failure is contained to its own query. It used to raise
        through the scroll task and take down the whole pass — the run stopped
        with `interrupted` and hours of collected evidence unexported. It is
        recorded as 'error', not 'stalled'/'no_results', so a later run retries it.
        """
        try:
            return await self.search(page, country, query, extractor, cap)
        except PlaywrightError as err:
            print(json.dumps({'country': country, 'query': query,
                              'error': str(err)[:300]}), flush=True)
            return 'error', 0

    async def check_page(self, page, country, body):
        """Stop on the states only the user can clear; verify the filters."""
        if '/checkpoint' in page.url or '/login' in page.url or await page.locator('input[name="email"], iframe[src*="captcha"]').count():
            raise StopScrape('Facebook needs manual login or verification; collection stopped.')
        if any(t in body.lower() for t in STOP_TEXT):
            raise StopScrape('Facebook access limit encountered; collection stopped.')
        filters = parse_qs(urlsplit(page.url).query)
        country_label = 'United States' if country == 'US' else 'United Kingdom'
        if filters.get('country') != [country] or filters.get('ad_type') != ['all'] or country_label not in body or 'All ads' not in body:
            raise StopScrape('Could not verify country and All ads filters.')

    async def first_results(self, page, country, extractor):
        """Wait for the first cards: ('cards', snapshot), ('no_results', []) or ('unrecognized', [])."""
        deadline = time.monotonic() + RENDER_WAIT_MS / 1000
        body = ''
        while True:
            body = await body_text(page)
            await self.check_page(page, country, body)
            snapshot = await page.evaluate(extractor)
            if snapshot:
                return 'cards', snapshot
            if any(t in body for t in NO_RESULTS_TEXT) or result_count(body) == 0:
                return 'no_results', []
            if time.monotonic() >= deadline:
                break
            await page.wait_for_timeout(2000)
        (OUT / 'unrecognized-page.txt').write_text(body, encoding='utf-8')
        return 'unrecognized', []

    async def search(self, page, country, query, extractor, cap=0):
        """Scroll one search until it stalls: (stop reason, cards seen)."""
        params = {'active_status': 'all', 'ad_type': 'all', 'country': country, 'q': query,
                  'search_type': 'keyword_unordered', 'media_type': 'all'}
        await page.goto('https://www.facebook.com/ads/library/?' + urlencode(params), wait_until='domcontentloaded', timeout=60000)
        state, first = await self.first_results(page, country, extractor)
        if state != 'cards':
            # 'unrecognized' is not a negative result: the search is retried on a later run.
            return state, 0
        seen, idle, scrolls = set(), 0, 0
        while idle < 6:
            if (OUT / 'STOP').exists():
                return 'stopped', len(seen)
            body = await body_text(page)
            await self.check_page(page, country, body)
            snapshot = first if scrolls == 0 else await page.evaluate(extractor)
            fresh = {a['adId'] for a in snapshot} - seen
            seen.update(a['adId'] for a in snapshot)
            idle = 0 if fresh else idle + 1
            await self.snapshots.put((country, query, page.url, now(), snapshot))
            # Extraction acknowledges every snapshot before scrolling again.
            await self.snapshots.join()
            self.status('running', country=country, query=query, scrolls=scrolls, uniqueInQuery=len(seen))
            scrolls += 1
            if self.args.max_scrolls and scrolls >= self.args.max_scrolls:
                return 'scroll_limit', len(seen)
            if cap and scrolls >= cap:
                # As far as this search is read on purpose: complete, and due again later.
                return 'capped', len(seen)
            await page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)')
            await page.wait_for_timeout(2500)
        return 'stalled', len(seen)

    def due_queries(self):
        """The searches this pass runs, in order: (country, is_discovery, query).

        Discovery seeds first, then the schools: those already seen advertising
        (so "running now" stays true for the ones that still are), then those
        with a saved Facebook page, then the rest.
        """
        prior = {(c, q): (s, o) for c, q, s, o in self.db.execute('SELECT country, query, status, observed_at FROM searches')}
        known = {(json.loads(raw).get('country'), name_key(json.loads(raw).get('name', '')))
                 for (raw,) in self.db.execute('SELECT data FROM ads')}
        out = []
        for country in ('US', 'GB'):
            for query in dict.fromkeys(SEEDS[:self.args.seeds]):
                out.append((0, country, True, query))
        if not self.args.seed_only:
            titles = {(l['country'], l['title']) for l in self.inventory['leads'] if l['title'].strip()}
            for country, title in titles:
                key = (country, name_key(title))
                has_page = any(facebook_key(l['facebookUrl']) for l in self.names[key])
                rank = 1 if key in known else (2 if has_page else 3)
                out.append((rank, country, False, title))
        out.sort(key=lambda item: (item[0], item[1] != 'US', item[3].casefold()))
        return [(c, d, q) for _, c, d, q in out
                if is_due(prior.get((c, q)), self.args.refresh, self.args.refresh_days)]

    async def scroll(self, ctx):
        page = await ctx.new_page()
        extractor = (Path(__file__).parent / 'extract.js').read_text(encoding='utf-8')
        try:
            # Replay durable ads so changed dates/new inventory don't need a new scrape.
            for (raw,) in self.db.execute('SELECT data FROM ads'):
                await self.ads.put(json.loads(raw))
            if self.args.replay_only:
                return
            unrecognized = 0
            for country, discovery, query in self.due_queries():
                if (OUT / 'STOP').exists():
                    return
                cap = DISCOVERY_SCROLLS if discovery else SCHOOL_SCROLLS
                reason, ads = await self.query_reason(page, country, query, extractor, cap)
                unrecognized = unrecognized + 1 if reason == 'unrecognized' else 0
                self.db.execute('INSERT OR REPLACE INTO searches VALUES(?,?,?,?)', (country, query, reason, now()))
                self.db.commit()
                self.counts['searches'] += 1
                self.export()
                print(json.dumps({'country': country, 'query': query, 'ads': ads, 'stopReason': reason}), flush=True)
                if unrecognized >= MAX_UNRECOGNIZED_IN_A_ROW:
                    raise StopScrape(f'{unrecognized} searches in a row showed no recognizable ad cards; '
                                     'inspect unrecognized-page.txt. No negative result inferred.')
        finally:
            await page.close()
            await self.snapshots.put(None)

    async def extract(self):
        seen = set()
        while True:
            item = await self.snapshots.get()
            try:
                if item is None:
                    await self.ads.put(None)
                    return
                country, query, url, observed, snapshot = item
                for ad in snapshot:
                    key = country, ad['adId']
                    if key in seen:
                        continue
                    seen.add(key)
                    ad.update(country=country, query=query, searchUrl=url, observedAt=observed)
                    self.db.execute('INSERT OR REPLACE INTO ads VALUES(?,?,?)', (country, ad['adId'], json.dumps(ad)))
                    await self.ads.put(ad)
                self.db.commit()
                if time.monotonic() - self.last_export > 30:
                    self.export()
            finally:
                self.snapshots.task_done()

    async def match(self):
        while True:
            ad = await self.ads.get()
            if ad is None:
                await self.candidates.put(None)
                return
            self.counts['ads'] += 1
            rows = self.names.get((ad['country'], name_key(ad['name'])), [])
            # Same URL with a changed school name is exported for review, never blue.
            rows = rows + self.urls.get((ad['country'], facebook_key(ad['facebookUrl'])), [])
            unique = {(r['spreadsheetId'], r['sheetId'], r['row']): r for r in rows}
            for lead in unique.values():
                await self.candidates.put((ad, lead))

    async def verify(self):
        while True:
            item = await self.candidates.get()
            if item is None:
                # The app's button is useful as soon as a match exists, even if
                # the colour pass is not requested or fails.
                await self.sync(force=True)
                if self.args.apply and self.counts['verified'] > self.applied_count:
                    await self.apply()
                return
            ad, lead = item
            equal_name = name_key(ad['name']) == name_key(lead['title'])
            key = facebook_key(lead['facebookUrl'])
            equal_url = bool(key and key == facebook_key(ad['facebookUrl']))
            eligible = qualifies(ad, self.args.start, self.args.end, self.args.include_active, self.args.all_time)
            # Two identities count as evidence for the filter tab: the page one
            # (the tab's own facebookUrl cell is the ad's page) and the name one
            # (the tab has no page URL, so an exact school name is the handle).
            # The blue backgrounds (--apply) still require the page match.
            is_evidence_row = is_evidence(name_match=equal_name, url_match=equal_url,
                                          own_page=bool(key), eligible=eligible)
            if equal_name and equal_url and eligible:
                reason = 'verified'
            elif is_evidence_row:
                reason = 'name_only'
            elif not equal_name:
                reason = 'name_review'
            elif not key:
                reason = 'missing_facebook_url'
            elif not equal_url:
                reason = 'facebook_url_mismatch'
            else:
                reason = 'dates_pending_or_outside_range'
            result = {'lead': lead, 'ad': ad, 'nameMatch': equal_name, 'urlMatch': equal_url,
                      'dateMatch': eligible, 'verified': equal_name and equal_url and eligible,
                      'evidence': is_evidence_row,
                      'matchKind': match_kind(equal_url),
                      'reason': reason}
            self.results[(lead['spreadsheetId'], lead['sheetId'], lead['row'], ad['adId'])] = result
            self.counts['prospects'] = len(self.results)
            self.counts['verified'] = sum(r['verified'] for r in self.results.values())
            self.counts['evidence'] = sum(r['evidence'] for r in self.results.values())
            await self.sync()
            if self.args.apply and self.counts['verified'] > self.applied_count and time.monotonic() - self.last_apply > 300:
                await self.apply()

    async def sync(self, force=False):
        """Upload the evidence so the app's Meta ad filter can use it.

        Every row whose school was matched to an ad goes up: by page when the
        tab had a facebookUrl, by exact name when it did not. Best effort: an
        upload failure never aborts a scrape that may have hours of evidence
        behind it. Nothing is counted as synced then, so the next pass retries,
        and the reason is kept in status.json and sync.log.
        """
        if self.args.no_sync:
            return
        rows = evidence_rows(self.results.values())
        if not rows or len(rows) <= self.synced:
            return
        if not force and time.monotonic() - self.last_sync < 120:
            return
        self.last_sync = time.monotonic()
        try:
            result = await upload(rows)
        except Exception as exc:  # noqa: BLE001 - reported, never fatal
            self.sync_state = 'failed'
            self.sync_note = str(exc)
            with (OUT / 'sync.log').open('a', encoding='utf-8') as log:
                log.write(f'{now()} {exc}\n')
            print(json.dumps({'sync': 'failed', 'error': str(exc)}), flush=True)
            return
        self.synced = len(rows)
        self.sync_state = 'ok'
        self.sync_note = None
        self.counts['synced'] = self.synced
        print(json.dumps({'sync': result, 'matches': len(rows)}), flush=True)

    async def sync_only(self):
        """Upload a previous run's prospects.json without opening Facebook."""
        self.status('syncing')
        payload = json.loads((OUT / 'prospects.json').read_text(encoding='utf-8'))
        for r in payload.get('results', []):
            lead, ad = r.get('lead') or {}, r.get('ad') or {}
            # Old result files predate `evidence`, and the rule for what counts
            # may have changed since the pass ran: decide again from the flags
            # the pass stored, so --sync-only uploads what verify() would.
            own_page = has_own_page(lead.get('facebookUrl'))
            r['evidence'] = is_evidence(name_match=r.get('nameMatch') is True,
                                        url_match=r.get('urlMatch') is True,
                                        own_page=own_page,
                                        eligible=r.get('dateMatch') is True)
            r['matchKind'] = match_kind(r.get('urlMatch') is True)
            self.results[(lead.get('spreadsheetId'), lead.get('sheetId'), lead.get('row'), ad.get('adId'))] = r
        self.counts['prospects'] = len(self.results)
        # Only evidenced rows are uploaded; the rest are review reasons.
        self.counts['verified'] = sum(1 for r in self.results.values() if r.get('verified'))
        self.counts['evidence'] = sum(1 for r in self.results.values() if r.get('evidence'))
        await self.sync(force=True)
        state = 'synced' if self.synced else 'nothing_to_sync'
        if self.sync_state == 'failed':
            state = 'sync_failed'
        self.status(state)
        self.export()
        self.db.close()

    async def apply(self):
        """Give the verified rows a blue background, best effort.

        A failed write is reported in status.json and the console, not raised:
        the evidence is already collected and exported, and a database blip must
        not end a pass that has hours of scrolling behind it. The throttle keeps
        the next candidate from spawning a bridge every few seconds.
        """
        self.export()
        self.last_apply = time.monotonic()
        code = 1
        for attempt in range(3):
            with (OUT / 'sheets.log').open('a', encoding='utf-8') as log:
                proc = await asyncio.create_subprocess_exec(
                    shutil.which('node'), str(ROOT / 'node_modules/tsx/dist/cli.mjs'),
                    '--env-file=../../.env', 'scripts/meta-ads-sheets.ts',
                    '--apply=../../.cache/meta-ads/prospects.json',
                    cwd=ROOT / 'apps/api', stdout=log, stderr=log)
                code = await proc.wait()
            if not code:
                break
            if attempt < 2:
                # Setting the same background is idempotent; retain every audit.
                await asyncio.sleep(5 * (attempt + 1))
        if code:
            self.apply_state = 'failed'
            self.apply_note = 'Sheets update failed; inspect sheets.log and color-audit files.'
            print(json.dumps({'apply': 'failed', 'note': self.apply_note}), flush=True)
            return
        self.apply_state = 'ok'
        self.apply_note = None
        self.applied_count = self.counts['verified']

    def export(self):
        self.last_export = time.monotonic()
        policy = {'start': str(self.args.start) if self.args.start else None, 'end': str(self.args.end) if self.args.end else None, 'includeActive': self.args.include_active, 'allTime': self.args.all_time}
        payload = {'createdAt': now(), 'policy': policy, 'results': list(self.results.values())}
        temporary = OUT / 'prospects.json.tmp'
        temporary.write_text(json.dumps(payload, indent=2), encoding='utf-8')
        temporary.replace(OUT / 'prospects.json')
        with (OUT / 'prospects.csv').open('w', encoding='utf-8-sig', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(['country', 'sheet', 'row', 'title', 'facebookUrl', 'advertiser', 'advertiserFacebookUrl', 'adId', 'status', 'dates', 'observedAt', 'verified', 'reason'])
            for r in self.results.values():
                l, a = r['lead'], r['ad']
                values = [l['country'], l['sheetTitle'], l['row'], l['title'], l['facebookUrl'], a['name'], a['facebookUrl'], a['adId'], a['status'], a['dateText'], a['observedAt'], r['verified'], r['reason']]
                writer.writerow(["'" + v if isinstance(v, str) and v.startswith(('=', '+', '-', '@')) else v for v in values])
        with (OUT / 'advertisers.csv').open('w', encoding='utf-8-sig', newline='') as f:
            writer = csv.writer(f)
            writer.writerow(['country', 'fullAdvertiserName', 'facebookUrl', 'adId', 'status', 'dates', 'observedAt'])
            for (raw,) in self.db.execute('SELECT data FROM ads'):
                a = json.loads(raw)
                values = [a[k] for k in ['country', 'name', 'facebookUrl', 'adId', 'status', 'dateText', 'observedAt']]
                writer.writerow(["'" + v if v.startswith(('=', '+', '-', '@')) else v for v in values])

    async def run(self):
        if self.args.sync_only:
            await self.sync_only()
            return
        if not self.args.replay_only and not self.due_queries():
            # The scheduled task starts this every hour; a browser only opens when a search is due.
            self.status('idle', note=f'Every search is less than {self.args.refresh_days:g} days old.')
            self.db.close()
            return
        self.status('starting')
        try:
            async with async_playwright() as p:
                ctx = await p.chromium.launch_persistent_context(str(OUT / 'browser'), channel='msedge', headless=True, locale='en-US')
                try:
                    await import_once(ctx, ROOT / 'www.facebook.com_cookies.txt', FACEBOOK_HOSTS, OUT / 'browser', '.cookies-imported')
                    async with asyncio.TaskGroup() as group:
                        group.create_task(self.scroll(ctx))
                        group.create_task(self.extract())
                        group.create_task(self.match())
                        group.create_task(self.verify())
                finally:
                    await ctx.close()
            self.status('stopped' if (OUT / 'STOP').exists() else 'pass_finished', coverage='Observed results only; not proof of no ads elsewhere.')
        except BaseException as exc:
            self.status('interrupted', error='; '.join(str(e) for e in getattr(exc, 'exceptions', [exc])))
            raise
        finally:
            # An interrupted scrape still leaves matches worth keeping.
            await self.sync(force=True)
            self.export()
            self.db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--start', type=date.fromisoformat)
    parser.add_argument('--end', type=date.fromisoformat)
    parser.add_argument('--include-active', action='store_true')
    parser.add_argument('--all-time', action='store_true', help='Count every observed active or inactive ad, regardless of age')
    parser.add_argument('--apply', action='store_true', help='Apply verified blue backgrounds through the Sheets bridge')
    parser.add_argument('--seed-only', action='store_true')
    parser.add_argument('--seeds', type=int, default=len(SEEDS))
    parser.add_argument('--max-scrolls', type=int, default=0, help='0 scrolls until no new cards for six passes')
    parser.add_argument('--replay-only', action='store_true')
    parser.add_argument('--refresh', action='store_true', help='Run every search again now, however recent')
    parser.add_argument('--refresh-days', type=float, default=REFRESH_DAYS,
                        help='A finished search is due again after this many days')
    parser.add_argument('--no-sync', action='store_true', help='Do not upload matches; the Meta ad filter then has nothing to work from')
    parser.add_argument('--sync-only', action='store_true', help='Upload the existing prospects.json and exit; no browser')
    args = parser.parse_args()
    if bool(args.start) != bool(args.end) or (args.start and args.end < args.start):
        parser.error('Supply both start and end, with end on or after start.')
    if args.sync_only and (args.apply or args.replay_only or args.refresh or args.seed_only):
        parser.error('--sync-only uploads the saved results and runs alone.')
    if args.sync_only and args.no_sync:
        parser.error('--sync-only and --no-sync contradict each other.')
    OUT.mkdir(parents=True, exist_ok=True)
    with (OUT / 'worker.lock').open('a+b') as lock:
        lock.seek(0)
        if not lock.read(1):
            lock.write(b'0')
            lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            raise SystemExit('A Meta ads worker already holds this profile. Stop it before launching another.')
        try:
            (OUT / 'worker.pid').write_text(str(os.getpid()), encoding='ascii')
            asyncio.run(Pipeline(args).run())
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
