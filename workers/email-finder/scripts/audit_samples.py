"""Reproducible, stratified live evaluation. Reads websites only; never submits forms."""
import asyncio
import collections
import csv
import dataclasses
import json
import logging
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder import nlp
from email_finder.cache import Cache
from email_finder.config import REPO_ROOT, WORKER_DIR, load_settings
from email_finder.engine import Engine, Finding
from email_finder.fetch import Fetcher
from email_finder.search import BraveSearch
from email_finder.validate import DomainChecker
from evaluate import load_rows


async def main():
    logging.basicConfig(level=logging.WARNING)
    settings = load_settings()
    cache = Cache()
    fetcher = Fetcher(cache, settings.per_host_delay, settings.use_browser,
                      settings.chrome_profile_path, settings.browser_cdp_url)
    search = BraveSearch.from_settings(settings, cache)
    engine = Engine(fetcher, search, DomainChecker(cache), settings.max_site_pages)
    await asyncio.to_thread(nlp.nlp)
    samples = []
    inventory = {}
    for sheet in ('Texas.csv', 'England without London.csv'):
        rows = load_rows(REPO_ROOT / sheet)
        groups = collections.defaultdict(list)
        for row in rows:
            kind = 'no_website' if not row.website else 'social_only' if any(s in row.website for s in ('facebook.com', 'instagram.com')) else 'website'
            groups[kind].append(row)
        inventory[sheet] = {kind: len(group) for kind, group in groups.items()}
        for kind, group in sorted(groups.items()):
            random.Random(20261001).shuffle(group)
            samples.extend((sheet, kind, row) for row in group[:2])
    outdir = WORKER_DIR / 'reports'
    outdir.mkdir(exist_ok=True)
    records = []
    sem = asyncio.Semaphore(settings.concurrency)
    async def one(sheet, kind, row):
        async with sem:
            started = time.monotonic()
            try:
                finding = await asyncio.wait_for(engine.find(row), settings.row_timeout)
            except asyncio.TimeoutError:
                finding = Finding(notes=['Evaluation timeout'], retry_after=1800, research_complete=False)
            record = {'sheet': sheet, 'group': kind, 'school': row.title, 'website': row.website,
                      **dataclasses.asdict(finding), 'status': finding.status, 'seconds': round(time.monotonic() - started, 1)}
            records.append(record)
            # Save after every completed row so interruption does not lose the evaluation.
            (outdir / 'request-audit.json').write_text(json.dumps({'inventory': inventory, 'results': records}, indent=2), encoding='utf-8')
            print(f'{sheet}: {kind}: {finding.status}; completed {len(records)}/{len(samples)}', flush=True)
    try:
        await asyncio.gather(*(one(*sample) for sample in samples))
    finally:
        await fetcher.close()
        await search.close()
    print(json.dumps({'evaluated': len(records), 'statuses': dict(collections.Counter(r['status'] for r in records)),
                      'decision_maker': sum(r['email_type'] == 'decision-maker' for r in records),
                      'deferred': sum(bool(r['retry_after']) for r in records)}))


if __name__ == '__main__':
    asyncio.run(main())
