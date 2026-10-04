"""Run the engine's Instagram backup on real profiles and report what it finds.

  .venv/Scripts/python scripts/probe_instagram.py                 # the default corpus
  .venv/Scripts/python scripts/probe_instagram.py "https://www.instagram.com/x/=School Name"

For each profile: the 3-second Contact routine (refresh once if no button),
the bio, the websites/link-in-bio pages the profile lists, and the address the
engine would pick, with how it was found. Uses the signed-in social browser
with its own scratch profile (the worker's isn't touched) and the usual
Instagram pacing. Results go to .cache/instagram-probe.json.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.cache import Cache  # noqa: E402
from email_finder.config import CACHE_DIR, load_settings  # noqa: E402
from email_finder.engine import Engine, Row, _Job  # noqa: E402
from email_finder.fetch import Fetcher, instagram_profile_url  # noqa: E402
from email_finder.validate import DomainChecker  # noqa: E402

# Profiles the user shared on 2026-10-04: two expected to have contact details,
# two that showed no Contact button within 3 seconds.
CORPUS = {
    "https://www.instagram.com/thegrindbjj/": "The Grind Martial Arts Academy",
    "https://www.instagram.com/warriormartialarts1/": "Warrior Martial Arts",
    "https://www.instagram.com/uskasdofficial/": "USKASD",
    "https://www.instagram.com/americancombatacademy/": "American Combat Academy",
}


class _NoSearch:
    enabled = False


async def probe(corpus: dict[str, str]) -> list[dict]:
    settings = load_settings()
    scratch = CACHE_DIR / "probe-social-profile"
    cache = Cache(CACHE_DIR / "probe.sqlite")
    fetcher = Fetcher(cache, settings.per_host_delay, True, chrome_profile_path=str(scratch),
                      social_cookies={"facebook": settings.facebook_cookies,
                                      "instagram": settings.instagram_cookies})
    engine = Engine(fetcher, _NoSearch(), DomainChecker(cache))  # type: ignore[arg-type]
    report = []
    try:
        for url, title in corpus.items():
            started = time.monotonic()
            job = _Job(engine, Row(title=title, instagram=url))
            await job._scrape_social_profiles()
            best = await job._decide()
            await job._finish(best)
            f = job.finding
            item = {
                "profile": instagram_profile_url(url), "title": title,
                "email": f.email, "type": f.email_type, "confidence": f.confidence,
                "method": f.method, "source": f.source_url,
                "pages_read": [p.url for p in job.pages],
                "instagram_paused_s": int(fetcher.social_paused("instagram")),
                "seconds": round(time.monotonic() - started),
            }
            report.append(item)
            print(json.dumps(item, indent=1), flush=True)
            if item["instagram_paused_s"]:
                print("Instagram pushed back; stopping the probe.")
                break
    finally:
        await fetcher.close()
        # The scratch profile holds a copy of the signed-in sessions.
        shutil.rmtree(scratch, ignore_errors=True)
        for extra in scratch.parent.glob(scratch.name + "-*"):
            shutil.rmtree(extra, ignore_errors=True)
    (CACHE_DIR / "instagram-probe.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    return report


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    corpus = CORPUS
    if len(sys.argv) > 1:
        corpus = {}
        for arg in sys.argv[1:]:
            url, _, title = arg.partition("=")
            corpus[url] = title or instagram_profile_url(url).rstrip("/").rsplit("/", 1)[-1]
    asyncio.run(probe(corpus))


if __name__ == "__main__":
    main()
