"""Run the engine on a random sample of a lead sheet CSV and report hit rates.

  .venv/Scripts/python scripts/evaluate.py "../../Texas.csv" --rows 200 --seed 7
  .venv/Scripts/python scripts/evaluate.py "../../England without London.csv" --rows 200 --seed 7

Writes reports/<sheet>-<n>-seed<s>.csv with every finding.
Uses Brave / BEAVE search (billed per query) but caches results for reruns.

Metrics produced
  FOUND            — an email address was found
  CONTACT_FORM     — only a contact form URL was found
  NOT_FOUND        — nothing found
  decision-maker   — email classified as the school owner / head instructor
  business         — generic info@ / office@ type address
  domain_match     — email domain matches the school's website domain (quality proxy)
  free_mail        — Gmail / Hotmail etc (small schools often use these personally)
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import csv
import json
import logging
import random
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from email_finder.cache import Cache          # noqa: E402
from email_finder.config import WORKER_DIR, load_settings  # noqa: E402
from email_finder.engine import Engine, Row  # noqa: E402
from email_finder.fetch import Fetcher        # noqa: E402
from email_finder.search import BraveSearch   # noqa: E402
from email_finder.sources import FREE_MAIL_DOMAINS  # noqa: E402
from email_finder.validate import DomainChecker  # noqa: E402


# ── CSV helpers ────────────────────────────────────────────────────────────────

def load_rows(path: Path) -> list[Row]:
    with path.open(encoding="utf-8-sig", newline="") as fh:
        records = list(csv.DictReader(fh))
    domains: collections.Counter[str] = collections.Counter(
        _domain(r.get("websiteUrl", "")) for r in records
    )
    rows: list[Row] = []
    for r in records:
        title = r.get("title", "").strip()
        if not title:
            continue
        website = r.get("websiteUrl", "").strip()
        rows.append(Row(
            title=title,
            website=website,
            address=r.get("address", "").strip(),
            phone=r.get("phoneNumber", "").strip(),
            category=r.get("category", "").strip(),
            facebook=r.get("facebookUrl", "").strip(),
            instagram=r.get("instagramUrl", "").strip(),
            shared_domain_count=domains[_domain(website)] if website else 1,
        ))
    return rows


def _domain(url: str) -> str:
    return urlsplit(url if "//" in url else "https://" + url).netloc.lower().removeprefix("www.")


def _email_domain(email: str) -> str:
    return email.split("@")[-1].lower() if "@" in email else ""


def _site_domain(url: str) -> str:
    import tldextract as _tld
    ext = _tld.extract(url)
    return f"{ext.domain}.{ext.suffix}" if ext.suffix else ext.domain


# ── metrics ────────────────────────────────────────────────────────────────────

def compute_metrics(results: list[tuple]) -> dict:
    n = len(results)
    if n == 0:
        return {}
    found       = sum(1 for _, f, _ in results if f.status == "FOUND")
    cf_only     = sum(1 for _, f, _ in results if f.status == "CONTACT_FORM")
    not_found   = sum(1 for _, f, _ in results if f.status == "NOT_FOUND")
    dm          = sum(1 for _, f, _ in results if f.email_type == "decision-maker")
    biz         = sum(1 for _, f, _ in results if f.email_type == "business")
    staff       = sum(1 for _, f, _ in results if f.email_type == "staff")
    dm_named    = sum(1 for _, f, _ in results if f.decision_maker)
    searches    = sum(f.searches for _, f, _ in results)
    avg_conf    = (sum(f.confidence for _, f, _ in results if f.confidence) /
                   max(1, sum(1 for _, f, _ in results if f.confidence)))

    # Quality proxies (no ground truth, but useful signals)
    domain_match = 0
    free_mail_count = 0
    for row, f, _ in results:
        if not f.email:
            continue
        ed = _email_domain(f.email)
        sd = _site_domain(row.website) if row.website else ""
        if sd and ed and (ed == sd or ed.endswith("." + sd) or sd.endswith("." + ed)):
            domain_match += 1
        if ed in FREE_MAIL_DOMAINS:
            free_mail_count += 1

    with_site   = [(r, f) for r, f, _ in results if r.website and "facebook" not in r.website.lower()]
    no_site     = [(r, f) for r, f, _ in results if not r.website or "facebook" in r.website.lower()]

    return {
        "total": n,
        "found": found,
        "found_pct": round(found / n * 100, 1),
        "contact_form_only": cf_only,
        "not_found": not_found,
        "decision_maker": dm,
        "dm_pct_of_found": round(dm / max(1, found) * 100, 1),
        "business": biz,
        "staff": staff,
        "dm_named": dm_named,
        "domain_match": domain_match,
        "domain_match_pct": round(domain_match / max(1, found) * 100, 1),
        "free_mail": free_mail_count,
        "free_mail_pct": round(free_mail_count / max(1, found) * 100, 1),
        "avg_confidence": round(avg_conf, 1),
        "total_searches": searches,
        "with_site_found": f"{sum(1 for _, f in with_site if f.email)}/{len(with_site)}",
        "no_site_found":   f"{sum(1 for _, f in no_site if f.email)}/{len(no_site)}",
    }


# ── entry point ────────────────────────────────────────────────────────────────

async def run_eval(csv_path: Path, n_rows: int, seed: int, label: str = "") -> dict:
    settings = load_settings()
    rows = load_rows(csv_path)
    rng = random.Random(seed)
    rng.shuffle(rows)
    sample = rows[:n_rows]

    cache = Cache()
    fetcher = Fetcher(
        cache,
        settings.per_host_delay,
        settings.use_browser,
        chrome_profile_path=settings.chrome_profile_path,
        browser_cdp_url=settings.browser_cdp_url,
    )
    search = BraveSearch.from_settings(settings, cache)
    engine = Engine(fetcher, search, DomainChecker(cache), settings.max_site_pages)
    sem = asyncio.Semaphore(settings.concurrency)
    started = time.monotonic()

    async def one(row: Row):
        async with sem:
            t = time.monotonic()
            finding = await asyncio.wait_for(engine.find(row), timeout=settings.row_timeout)
            return row, finding, time.monotonic() - t

    results = await asyncio.gather(*(one(r) for r in sample))
    await fetcher.close()
    await search.close()

    elapsed = time.monotonic() - started
    metrics = compute_metrics(list(results))
    metrics["elapsed_s"] = round(elapsed, 1)
    metrics["seed"] = seed
    metrics["label"] = label or csv_path.stem

    # Save CSV report
    out_dir = WORKER_DIR / "reports"
    out_dir.mkdir(exist_ok=True)
    tag = f"-seed{seed}" if seed != 7 else ""
    out = out_dir / f"{csv_path.stem}-{n_rows}{tag}.csv"
    with out.open("w", encoding="utf-8", newline="") as fh:
        w = csv.writer(fh)
        w.writerow([
            "title", "website", "status", "email", "type", "confidence",
            "decisionMaker", "source", "contactForm", "searches", "seconds", "notes",
        ])
        for row, f, secs in results:
            w.writerow([
                row.title, row.website, f.status,
                f.email or "", f.email_type or "", f.confidence,
                f.decision_maker or "", f.source_url or "",
                f.contact_form_url or "", f.searches,
                round(secs, 1), "; ".join(f.notes),
            ])

    # Save JSON metrics
    metrics_out = out.with_suffix(".json")
    with metrics_out.open("w", encoding="utf-8") as fh:
        json.dump(metrics, fh, indent=2)

    return {"metrics": metrics, "csv": out, "results": results}


def print_metrics(metrics: dict, title: str) -> None:
    print(f"\n{'─'*60}")
    print(f"  {title}")
    print(f"{'─'*60}")
    print(f"  Rows evaluated  : {metrics['total']:>6}")
    print(f"  FOUND           : {metrics['found']:>6}  ({metrics['found_pct']}%)")
    print(f"  CONTACT FORM    : {metrics['contact_form_only']:>6}")
    print(f"  NOT FOUND       : {metrics['not_found']:>6}")
    print(f"  Decision-maker  : {metrics['decision_maker']:>6}  ({metrics['dm_pct_of_found']}% of found)")
    print(f"  Business inbox  : {metrics['business']:>6}")
    print(f"  Staff inbox     : {metrics['staff']:>6}")
    print(f"  DM named (NLP)  : {metrics['dm_named']:>6}")
    print(f"  Domain match    : {metrics['domain_match']:>6}  ({metrics['domain_match_pct']}% of found)")
    print(f"  Free mail (Gmail): {metrics['free_mail']:>5}  ({metrics['free_mail_pct']}% of found)")
    print(f"  Avg confidence  : {metrics['avg_confidence']:>6}")
    print(f"  Search queries  : {metrics['total_searches']:>6}")
    print(f"  With website    : {metrics['with_site_found']:>10}  found")
    print(f"  No website      : {metrics['no_site_found']:>10}  found")
    print(f"  Time            : {metrics['elapsed_s']:>6}s")


async def main() -> None:
    ap = argparse.ArgumentParser(description="Evaluate email finder on a lead CSV.")
    ap.add_argument("csv", type=Path)
    ap.add_argument("--rows", type=int, default=200)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--label", type=str, default="")
    args = ap.parse_args()

    logging.basicConfig(level=logging.WARNING)
    result = await run_eval(args.csv, args.rows, args.seed, args.label)
    print_metrics(result["metrics"], f"{args.csv.name}  rows={args.rows}  seed={args.seed}")
    print(f"\n  Report : {result['csv']}")


if __name__ == "__main__":
    asyncio.run(main())
