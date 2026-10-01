"""The email finder worker: runs on the user's PC, pulls rows from the API,
researches them a few at a time and posts results back. Safe to stop at any
time; unfinished rows return to the queue after 20 minutes.

  .venv/Scripts/python -m email_finder.worker
"""

from __future__ import annotations

import asyncio
import logging
import logging.handlers
import signal
import sys

import httpx

from .cache import Cache
from .config import CACHE_DIR, load_settings
from .engine import Engine, Finding, Row
from .fetch import Fetcher
from .search import BraveSearch
from .validate import DomainChecker

log = logging.getLogger("email_finder.worker")
IDLE_POLL_SECONDS = 20
HEARTBEAT_SECONDS = 45


def setup_logging() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(
        CACHE_DIR / "worker.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler, logging.StreamHandler(sys.stdout)])
    for noisy in ("httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


class Api:
    def __init__(self, base: str, token: str) -> None:
        self._client = httpx.AsyncClient(
            base_url=f"{base}/api/email-finder/worker",
            headers={"x-worker-token": token},
            timeout=30.0,
        )

    async def close(self) -> None:
        await self._client.aclose()

    async def heartbeat(self) -> None:
        (await self._client.post("/heartbeat")).raise_for_status()

    async def claim(self, n: int) -> list[dict]:
        res = await self._client.post("/claim", json={"max": n})
        res.raise_for_status()
        return res.json().get("rows", [])

    async def submit(self, results: list[dict]) -> None:
        (await self._client.post("/results", json={"results": results})).raise_for_status()


def to_row(data: dict) -> Row:
    return Row(
        title=data.get("title", ""),
        website=data.get("website", ""),
        address=data.get("address", ""),
        phone=data.get("phone", ""),
        category=data.get("category", ""),
        facebook=data.get("facebook", ""),
        instagram=data.get("instagram", ""),
        shared_domain_count=int(data.get("sharedDomainCount") or 1),
    )


def to_result(row_id: str, f: Finding) -> dict:
    return {
        "id": row_id,
        "status": f.status if not (f.notes and f.notes[0].startswith("error:")) else "FAILED",
        "email": f.email,
        "emailType": f.email_type,
        "confidence": f.confidence or None,
        "sourceUrl": f.source_url,
        "decisionMaker": f.decision_maker,
        "contactFormUrl": f.contact_form_url,
        "notes": "; ".join(f.notes) or None,
    }


async def run() -> None:
    settings = load_settings()
    if not settings.worker_token:
        log.error("EMAIL_FINDER_WORKER_TOKEN is missing from the repo's .env; nothing to do.")
        return
    if not settings.brave_api_key:
        log.warning("BRAVE_API_KEY is missing: only school websites will be searched.")

    cache = Cache()
    fetcher = Fetcher(cache, settings.per_host_delay, settings.use_browser)
    search = BraveSearch(settings.brave_api_key, cache, settings.brave_daily_limit)
    engine = Engine(fetcher, search, DomainChecker(cache), settings.max_site_pages)
    api = Api(settings.api_base, settings.worker_token)
    stop = asyncio.Event()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except NotImplementedError:  # Windows: Ctrl+C raises KeyboardInterrupt instead
            pass

    async def heartbeat_loop() -> None:
        while not stop.is_set():
            try:
                await api.heartbeat()
            except httpx.HTTPError as err:
                log.warning("heartbeat failed: %s", err)
            await _sleep(stop, HEARTBEAT_SECONDS)

    async def research(item: dict) -> None:
        row = to_row(item["input"])
        finding = await engine.find(row)
        log.info("%s -> %s %s (%s)", row.title, finding.status, finding.email or "", finding.email_type or "-")
        for attempt in range(5):
            try:
                await api.submit([to_result(item["id"], finding)])
                return
            except httpx.HTTPError as err:
                log.warning("could not post result (try %d): %s", attempt + 1, err)
                await asyncio.sleep(10 * (attempt + 1))

    beat = asyncio.create_task(heartbeat_loop())
    backoff = IDLE_POLL_SECONDS
    log.info("email finder worker started (API %s, %d at a time)", settings.api_base, settings.concurrency)
    try:
        while not stop.is_set():
            try:
                batch = await api.claim(settings.concurrency)
                backoff = IDLE_POLL_SECONDS
            except httpx.HTTPStatusError as err:
                if err.response.status_code == 401:
                    log.error("the API rejected the worker token; check EMAIL_FINDER_WORKER_TOKEN")
                else:
                    log.warning("claim failed: %s", err)
                batch, backoff = [], min(backoff * 2, 300)
            except httpx.HTTPError as err:
                log.warning("API unreachable: %s", err)
                batch, backoff = [], min(backoff * 2, 300)
            if not batch:
                await fetcher.close_idle_browser()
                await _sleep(stop, backoff)
                continue
            await asyncio.gather(*(research(item) for item in batch))
    finally:
        stop.set()
        beat.cancel()
        await asyncio.gather(beat, return_exceptions=True)
        await api.close()
        await fetcher.close()
        await search.close()
        log.info("email finder worker stopped")


async def _sleep(stop: asyncio.Event, seconds: float) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass


def main() -> None:
    setup_logging()
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
