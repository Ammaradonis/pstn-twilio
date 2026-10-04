"""Trace the engine on rows whose title contains the given text.

  .venv/Scripts/python scripts/debug_row.py "../../Texas.csv" "Lopez Judo"
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from email_finder.cache import Cache  # noqa: E402
from email_finder.config import load_settings  # noqa: E402
from email_finder.engine import Engine, _Job  # noqa: E402
from email_finder.fetch import Fetcher  # noqa: E402
from email_finder.search import BraveSearch  # noqa: E402
from email_finder.validate import DomainChecker, plausible  # noqa: E402
from evaluate import load_rows  # noqa: E402


async def main() -> None:
    path, needle = Path(sys.argv[1]), sys.argv[2].lower()
    s = load_settings()
    cache = Cache()
    fetcher = Fetcher(cache, s.per_host_delay, s.use_browser)
    search = BraveSearch.from_settings(s, cache)
    engine = Engine(fetcher, search, DomainChecker(cache), s.max_site_pages)
    for row in [r for r in load_rows(path) if needle in r.title.lower()][:3]:
        job = _Job(engine, row)
        finding = await job.run()
        print(f"\n=== {row.title} | {row.website} | town={job.town} tokens={job.tokens} shared={row.shared_domain_count}")
        print("pages:", [p.url for p in job.pages])
        print("social:", sorted(job.social)[:5], "forms:", job.forms[:3])
        persons = await job._people()
        print("people:", persons[:5])
        own = [c.email for c in job.candidates if job.site_domain and c.email.endswith(job.site_domain)]
        for email in dict.fromkeys(c.email for c in job.candidates):
            seen = [c for c in job.candidates if c.email == email]
            sc = job._score(email, seen, persons, bool(own)) if plausible(email) else None
            print(f"  {email:40} plausible={plausible(email)} score={sc and sc.score} kind={sc and sc.kind} "
                  f"src={seen[0].source} rel={any(job._relevant(c.context) for c in seen)} url={seen[0].url[:60]}")
        print("site_is_schools:", job.site_is_schools, "own:", job.own_domains, "phone:", job.phone_digits)
        for c in job.candidates[:4]:
            print("   ctx", c.email, c.source, "::", c.context[:160])
        print("finding:", finding)
    await fetcher.close()
    await search.close()


asyncio.run(main())
