"""Run the engine on a random sample of a lead sheet CSV and report hit rates.

  .venv/Scripts/python scripts/evaluate.py "../../Texas.csv" --rows 25 --seed 7

Writes reports/<sheet>-<n>.csv with every finding. Uses Brave (billed per query).
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import csv
import logging
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from email_finder.cache import Cache  # noqa: E402
from email_finder.config import WORKER_DIR, load_settings  # noqa: E402
from email_finder.engine import Engine, Row  # noqa: E402
from email_finder.fetch import Fetcher  # noqa: E402
from email_finder.search import BraveSearch  # noqa: E402
from email_finder.validate import DomainChecker  # noqa: E402


def load_rows(path: Path) -> list[Row]:
    with path.open(encoding="utf-8-sig", newline="") as fh:
        records = list(csv.DictReader(fh))
    domains = collections.Counter(_domain(r.get("websiteUrl", "")) for r in records)
    rows = []
    for r in records:
        rows.append(
            Row(
                title=r.get("title", "").strip(),
                website=r.get("websiteUrl", "").strip(),
                address=r.get("address", "").strip(),
                phone=r.get("phoneNumber", "").strip(),
                category=r.get("category", "").strip(),
                facebook=r.get("facebookUrl", "").strip(),
                instagram=r.get("instagramUrl", "").strip(),
                shared_domain_count=domains[_domain(r.get("websiteUrl", ""))] if r.get("websiteUrl") else 1,
            )
        )
    return [r for r in rows if r.title]


def _domain(url: str) -> str:
    from urllib.parse import urlsplit

    return urlsplit(url if "//" in url else "https://" + url).netloc.lower().removeprefix("www.")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", type=Path)
    ap.add_argument("--rows", type=int, default=25)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    logging.basicConfig(level=logging.WARNING)

    settings = load_settings()
    rows = load_rows(args.csv)
    random.Random(args.seed).shuffle(rows)
    sample = rows[: args.rows]

    cache = Cache()
    fetcher = Fetcher(cache, settings.per_host_delay, settings.use_browser)
    search = BraveSearch(settings.brave_api_key, cache, settings.brave_daily_limit)
    engine = Engine(fetcher, search, DomainChecker(cache), settings.max_site_pages)
    sem = asyncio.Semaphore(settings.concurrency)
    started = time.monotonic()

    async def one(row: Row):
        async with sem:
            t = time.monotonic()
            finding = await engine.find(row)
            return row, finding, time.monotonic() - t

    results = await asyncio.gather(*(one(r) for r in sample))
    await fetcher.close()
    await search.close()

    out_dir = WORKER_DIR / "reports"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / f"{args.csv.stem}-{len(sample)}.csv"
    with out.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["title", "website", "status", "email", "type", "confidence", "decisionMaker", "source", "contactForm", "searches", "seconds", "notes"])
        for row, f, secs in results:
            w.writerow([row.title, row.website, f.status, f.email or "", f.email_type or "", f.confidence,
                        f.decision_maker or "", f.source_url or "", f.contact_form_url or "", f.searches,
                        round(secs, 1), "; ".join(f.notes)])

    n = len(results)
    by_status = collections.Counter(f.status for _, f, _ in results)
    by_type = collections.Counter(f.email_type for _, f, _ in results if f.email)
    with_site = [(r, f) for r, f, _ in results if r.website and "facebook" not in r.website]
    no_site = [(r, f) for r, f, _ in results if not r.website or "facebook" in r.website]
    print(f"\n{args.csv.name}: {n} rows in {time.monotonic() - started:.0f}s, {sum(f.searches for _, f, _ in results)} searches")
    print("  status:", dict(by_status))
    print("  email types:", dict(by_type))
    print(f"  with website: {sum(1 for _, f in with_site if f.email)}/{len(with_site)} emails")
    print(f"  no website / Facebook only: {sum(1 for _, f in no_site if f.email)}/{len(no_site)} emails")
    print(f"  decision maker named: {sum(1 for _, f, _ in results if f.decision_maker)}/{n}")
    print(f"  report: {out}")


if __name__ == "__main__":
    asyncio.run(main())
