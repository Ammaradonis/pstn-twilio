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
import sqlite3
import shutil
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlencode, urlsplit, parse_qs

from matching import name_key, facebook_key, qualifies
from remote import evidence_rows, upload

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.cache/meta-ads'
sys.path.insert(0, str(ROOT / 'workers/email-finder'))
from email_finder.cookies import import_once, FACEBOOK_HOSTS
from playwright.async_api import async_playwright

SEEDS = ['martial arts', 'karate', 'taekwondo', 'jiu jitsu', 'kickboxing', 'kung fu', 'judo', 'aikido', 'self defense']


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
        self.counts = {'ads': 0, 'prospects': 0, 'verified': 0, 'searches': 0, 'synced': 0}

    def status(self, state, **extra):
        (OUT / 'status.json').write_text(json.dumps({'state': state, 'updatedAt': now(), **self.counts,
                                                     'sync': {'state': self.sync_state, 'note': self.sync_note, 'synced': self.synced},
                                                     **extra}, indent=2), encoding='utf-8')

    async def scroll(self, ctx):
        page = await ctx.new_page()
        extractor = (Path(__file__).parent / 'extract.js').read_text(encoding='utf-8')
        try:
            # Replay durable ads so changed dates/new inventory don't need a new scrape.
            for (raw,) in self.db.execute('SELECT data FROM ads'):
                await self.ads.put(json.loads(raw))
            if self.args.replay_only:
                return
            # Discovery covers both countries before per-school searches begin.
            for country, discovery in [('US', True), ('GB', True), ('US', False), ('GB', False)]:
                if not discovery and self.args.seed_only:
                    continue
                queries = list(SEEDS[:self.args.seeds])
                if not discovery:
                    queries = sorted({l['title'] for l in self.inventory['leads'] if l['country'] == country},
                                     key=lambda title: (not any(facebook_key(l['facebookUrl']) for l in self.names[(country, name_key(title))]), title))
                for query in dict.fromkeys(queries):
                    if (OUT / 'STOP').exists():
                        return
                    prior = self.db.execute('SELECT status FROM searches WHERE country=? AND query=?', (country, query)).fetchone()
                    if prior and prior[0] in ('stalled', 'no_results') and not self.args.refresh:
                        continue
                    params = {'active_status': 'all', 'ad_type': 'all', 'country': country, 'q': query,
                              'search_type': 'keyword_unordered', 'media_type': 'all'}
                    await page.goto('https://www.facebook.com/ads/library/?' + urlencode(params), wait_until='domcontentloaded', timeout=60000)
                    await page.wait_for_timeout(5000)
                    seen, idle, scrolls = set(), 0, 0
                    reason = 'stalled'
                    while idle < 6:
                        if (OUT / 'STOP').exists():
                            reason = 'stopped'
                            break
                        body = await page.locator('body').inner_text()
                        if '/checkpoint' in page.url or '/login' in page.url or await page.locator('input[name="email"], iframe[src*="captcha"]').count():
                            raise RuntimeError('Facebook needs manual login or verification; collection stopped.')
                        if any(t in body.lower() for t in ['temporarily blocked', 'you’re temporarily blocked', 'too many requests', 'confirm you are human']):
                            raise RuntimeError('Facebook access limit encountered; collection stopped.')
                        filters = parse_qs(urlsplit(page.url).query)
                        country_label = 'United States' if country == 'US' else 'United Kingdom'
                        if filters.get('country') != [country] or filters.get('ad_type') != ['all'] or country_label not in body or 'All ads' not in body:
                            raise RuntimeError('Could not verify country and All ads filters.')
                        snapshot = await page.evaluate(extractor)
                        if not snapshot and ('No ads match' in body or 'No results found' in body):
                            reason = 'no_results'
                            break
                        if not snapshot and scrolls == 0:
                            (OUT / 'unrecognized-page.txt').write_text(body, encoding='utf-8')
                            raise RuntimeError('No recognizable ad cards; inspect unrecognized-page.txt. No negative result inferred.')
                        fresh = {a['adId'] for a in snapshot} - seen
                        seen.update(a['adId'] for a in snapshot)
                        idle = 0 if fresh else idle + 1
                        await self.snapshots.put((country, query, page.url, now(), snapshot))
                        # Extraction acknowledges every snapshot before scrolling again.
                        await self.snapshots.join()
                        self.status('running', country=country, query=query, scrolls=scrolls, uniqueInQuery=len(seen))
                        scrolls += 1
                        if self.args.max_scrolls and scrolls >= self.args.max_scrolls:
                            reason = 'scroll_limit'
                            break
                        await page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)')
                        await page.wait_for_timeout(2500)
                    self.db.execute('INSERT OR REPLACE INTO searches VALUES(?,?,?,?)', (country, query, reason, now()))
                    self.db.commit()
                    self.counts['searches'] += 1
                    self.export()
                    print(json.dumps({'country': country, 'query': query, 'ads': len(seen), 'stopReason': reason}), flush=True)
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
            result = {'lead': lead, 'ad': ad, 'nameMatch': equal_name, 'urlMatch': equal_url,
                      'dateMatch': eligible, 'verified': equal_name and equal_url and eligible,
                      'reason': 'verified' if equal_name and equal_url and eligible else
                          'name_review' if not equal_name else 'missing_facebook_url' if not key else
                          'facebook_url_mismatch' if not equal_url else 'dates_pending_or_outside_range'}
            self.results[(lead['spreadsheetId'], lead['sheetId'], lead['row'], ad['adId'])] = result
            self.counts['prospects'] = len(self.results)
            self.counts['verified'] = sum(r['verified'] for r in self.results.values())
            await self.sync()
            if self.args.apply and self.counts['verified'] > self.applied_count and time.monotonic() - self.last_apply > 300:
                await self.apply()

    async def sync(self, force=False):
        """Upload verified matches so the app's Meta ad filter can use them.

        Best effort: an upload failure never aborts a scrape that may have hours
        of evidence behind it. Nothing is counted as synced then, so the next
        pass retries, and the reason is kept in status.json and sync.log.
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
            self.results[(lead.get('spreadsheetId'), lead.get('sheetId'), lead.get('row'), ad.get('adId'))] = r
        self.counts['prospects'] = len(self.results)
        # Only verified rows are evidence; the rest are review reasons.
        self.counts['verified'] = sum(1 for r in self.results.values() if r.get('verified'))
        await self.sync(force=True)
        state = 'synced' if self.synced else 'nothing_to_sync'
        if self.sync_state == 'failed':
            state = 'sync_failed'
        self.status(state)
        self.export()
        self.db.close()

    async def apply(self):
        self.export()
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
            raise RuntimeError('Sheets update failed; inspect sheets.log and color-audit files before restarting.')
        self.applied_count = self.counts['verified']
        self.last_apply = time.monotonic()

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
    parser.add_argument('--refresh', action='store_true')
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
