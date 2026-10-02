"""Reproducible, resumable website-only research corpus. Never sends messages.

The CSVs have no verified email labels. Evidence is retained for heuristic
calibration and grouped holdout evaluation, not supervised accuracy claims.
"""
from __future__ import annotations
import argparse
import asyncio
from collections import Counter
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict
import hashlib
import json
import logging
import os
from pathlib import Path
import random
import sys
import time

# Small spaCy batches should not contend with the HTTP loop or calling apps for
# every CPU thread. Respect an explicitly configured thread count.
for variable in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(variable, "1")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.cache import Cache
from email_finder.config import REPO_ROOT, WORKER_DIR, load_settings
from email_finder.engine import Engine, Finding, _Job
from email_finder.fetch import Fetcher
from email_finder.search import BraveSearch
from email_finder.validate import DomainChecker, DnsUnavailable, plausible
from evaluate import load_rows


def below_normal_priority():
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.windll.kernel32
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.SetPriorityClass.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel.SetPriorityClass(kernel.GetCurrentProcess(), 0x4000)


def sample_rows(rows_per_csv: int, seed: int) -> list[dict]:
    result = []
    for filename in ("England without London.csv", "Texas.csv"):
        path = REPO_ROOT / filename
        rows = load_rows(path)
        random.Random(f"{seed}:{filename}").shuffle(rows)
        for row in rows[:rows_per_csv]:
            identity = json.dumps(asdict(row), sort_keys=True)
            result.append({"id": hashlib.sha256((filename + identity).encode()).hexdigest(),
                           "source": filename, "row": asdict(row)})
    random.Random(seed).shuffle(result)
    return result


async def collect(args):
    from email_finder.engine import Row
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = {"version": 1, "seed": args.seed, "rows_per_csv": args.rows,
                "max_site_pages": args.pages, "row_timeout": args.timeout,
                "mode": "website-only; browser and paid search disabled",
                "input_sha256": {name: hashlib.sha256((REPO_ROOT / name).read_bytes()).hexdigest()
                    for name in ("England without London.csv", "Texas.csv")},
                "sample": sample_rows(args.rows, args.seed)}
    manifest_path = args.output / "manifest.json"
    if manifest_path.exists():
        previous = json.loads(manifest_path.read_text(encoding="utf-8"))
        if previous != manifest:
            raise ValueError("Existing corpus has a different manifest; use a new output directory")
    else:
        manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    checkpoint = args.output / "corpus.jsonl"
    completed = {}
    if checkpoint.exists():
        for line in checkpoint.read_text(encoding="utf-8").splitlines():
            record = json.loads(line)
            completed[record["id"]] = record
    if args.retry_errors:
        successful = {key: record for key, record in completed.items() if not record.get("error")}
        if len(successful) != len(completed):
            checkpoint.replace(args.output / f"corpus-before-retry-{int(time.time())}.jsonl")
            checkpoint.write_text("".join(json.dumps(record, ensure_ascii=False) + "\n"
                                          for record in successful.values()), encoding="utf-8")
            completed = successful
    settings = load_settings()
    cache = Cache()
    fetcher = Fetcher(cache, per_host_delay=settings.per_host_delay, use_browser=False,
                      max_connections=args.concurrency)
    search = BraveSearch(None, cache, daily_limit=0)
    domains = DomainChecker(cache)
    pool = ProcessPoolExecutor(max_workers=args.nlp_processes, initializer=below_normal_priority) if args.nlp_processes else None
    engine = Engine(fetcher, search, domains, max_site_pages=args.pages, people_executor=pool)
    semaphore = asyncio.Semaphore(args.concurrency)
    started = time.monotonic()
    summary = Counter(r["status"] for r in completed.values())
    timeout = args.resume_timeout or args.timeout
    with (args.output / "execution-runs.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"started_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                 "resumed_rows": len(completed), "concurrency": args.concurrency,
                                 "timeout_s": timeout, "retry_errors": args.retry_errors,
                                 "nlp_processes": args.nlp_processes}) + "\n")
    print(f"Corpus: {len(manifest['sample'])} sampled rows, {len(completed)} already complete", flush=True)

    async def one(item):
        if item["id"] in completed:
            return
        async with semaphore:
            job = _Job(engine, Row(**item["row"]))
            begin = time.monotonic()
            error = None
            try:
                finding = await asyncio.wait_for(job.run(), timeout=timeout)
            except TimeoutError:
                error = "row_timeout"
                finding = Finding(notes=[error], research_complete=False)
            except Exception as exc:
                error = type(exc).__name__
                finding = Finding(notes=[error], research_complete=False)
            # Freeze domain validation for all candidates, including those below
            # the current score threshold. Missing DNS never counts as valid.
            dns = {}
            async def check(domain):
                try:
                    dns[domain] = await domains.accepts_mail(domain)
                except (DnsUnavailable, TimeoutError):
                    dns[domain] = None
            candidate_domains = sorted({c.email.split("@")[1] for c in job.candidates if plausible(c.email)})
            await asyncio.gather(*(check(d) for d in candidate_domains[:30]))
            record = {**item, "finding": asdict(finding), "status": "ERROR" if error else finding.status,
                      "error": error, "seconds": round(time.monotonic() - begin, 3),
                      "timeout_s": timeout,
                      "pages_read": len(job.pages), "forms": job.forms,
                      "candidates": [asdict(c) for c in job.candidates],
                      "persons": [asdict(p) for p in job._persons_cache], "dns": dns,
                      "site_host": job.site_host, "site_domain": job.site_domain,
                      "site_is_schools": job.site_is_schools, "own_domains": sorted(job.own_domains)}
            with checkpoint.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
                handle.flush()
            completed[item["id"]] = record
            summary[record["status"]] += 1
            if len(completed) % 25 == 0 or len(completed) == len(manifest["sample"]):
                progress = {"complete": len(completed), "total": len(manifest["sample"]),
                            "statuses": dict(summary), "elapsed_s": round(time.monotonic() - started)}
                (args.output / "progress.json").write_text(json.dumps(progress, indent=2), encoding="utf-8")
                print(json.dumps(progress), flush=True)
    try:
        await asyncio.gather(*(one(item) for item in manifest["sample"]))
    finally:
        await fetcher.close()
        await search.close()
        cache._db.close()
        if pool:
            pool.shutdown(wait=True, cancel_futures=True)
    print("Corpus complete: " + str(checkpoint), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rows", type=int, default=1200, help="Random rows per CSV")
    parser.add_argument("--seed", type=int, default=20261001)
    parser.add_argument("--pages", type=int, default=6)
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--resume-timeout", type=int, help="Logged timeout override when resuming slow rows")
    parser.add_argument("--concurrency", type=int, default=12)
    parser.add_argument("--nlp-processes", type=int, choices=(0, 1, 2), default=1,
                        help="Isolated CPU workers; 0 uses the normal in-process model")
    parser.add_argument("--retry-errors", action="store_true", help="Retry failed rows, preserving the previous checkpoint")
    parser.add_argument("--output", type=Path, default=WORKER_DIR / "reports/training-20261001")
    args = parser.parse_args()
    if min(args.rows, args.pages, args.timeout, args.concurrency) < 1:
        parser.error("Numeric settings must be positive")
    below_normal_priority()
    logging.basicConfig(level=logging.ERROR)
    asyncio.run(collect(args))
