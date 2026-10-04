"""Live end-to-end probe of the free Google pathway (GOOGLE-FREE-SEARCH.txt).

Runs a real query through GoogleFreeSearch while the worker's shared Fetcher is
busy rendering pages, which is the interference that used to abort a search
mid-query. Read-only: no messages, no sheet writes.

    .venv\\Scripts\\python scripts\\probe_google_free.py "query one" "query two"
"""

from __future__ import annotations

import asyncio
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from email_finder.cache import Cache  # noqa: E402
from email_finder.fetch import Fetcher  # noqa: E402
from email_finder.google_free import GoogleFreeSearch, GoogleUnavailable  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
for noisy in ("httpx", "httpcore", "asyncio"):
    logging.getLogger(noisy).setLevel(logging.WARNING)

# A few slow pages the shared fetcher can render while Google is being asked.
BUSY_URLS = ("https://example.com", "https://www.iana.org/help/example-domains")


async def busy(fetcher: Fetcher) -> None:
    """Hammer the shared fetcher's browser the way a second row does."""
    for _ in range(3):
        for url in BUSY_URLS:
            try:
                await fetcher.render(url)
            except Exception:  # noqa: BLE001 - this is just background noise
                pass


async def main(queries: list[str]) -> int:
    # A cache of its own: the probe must not spend the worker's daily free-search
    # allowance or pause its Google state.
    cache = Cache(Path(__file__).resolve().parent.parent / ".cache" / "probe.sqlite")
    cache.set("search-state", "google-pause", {"until": 0, "step": 0}, 60)
    cache.set("search-state", "google-http-off", False, 60)
    fetcher = Fetcher(cache, per_host_delay=0.2, use_browser=True)
    # Own driver by default: the fetcher's browser shutdown must not reach it.
    google = GoogleFreeSearch(cache, gap=(0, 0), use_browser=True)
    print(f"own driver (not the fetcher's): {not google.share_fetcher_driver}", flush=True)
    noise = asyncio.create_task(busy(fetcher))
    failures = 0
    try:
        for q in queries:
            print(f"\n=== query: {q!r} ===", flush=True)
            t0 = time.monotonic()
            try:
                results = await google.search(q)
            except GoogleUnavailable as err:
                failures += 1
                print(f"FAILED after {time.monotonic() - t0:.1f}s: {err}", flush=True)
                continue
            print(f"OK: {len(results)} results in {time.monotonic() - t0:.1f}s", flush=True)
            for r in results[:3]:
                print(f"  - {r.url}\n    {r.title}", flush=True)
    finally:
        await noise
        await google.close()
        await fetcher.close()
    print(f"\nfailures: {failures}/{len(queries)}", flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    args = sys.argv[1:] or ['"Tiger Dojo" Austin TX martial arts email']
    sys.exit(asyncio.run(main(args)))
