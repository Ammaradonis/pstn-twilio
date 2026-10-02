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
import os
import contextlib
import sys

import httpx

from .cache import Cache
from .config import CACHE_DIR, load_settings
from .engine import Engine, Finding, Row
from .fetch import Fetcher
from .forms import FormSender
from . import nlp
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

    async def claim_forms(self) -> list[dict]:
        res = await self._client.post("/forms/claim")
        res.raise_for_status()
        return res.json().get("forms", [])

    async def arm_form(self, task: dict) -> bool:
        res = await self._client.post(f"/forms/{task['id']}/arm", json={"leaseToken": task["leaseToken"]})
        res.raise_for_status()
        return res.json().get("armed") is True

    async def form_result(self, item: dict) -> None:
        res = await self._client.post(f"/forms/{item['id']}/result", json=item)
        res.raise_for_status()

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


def to_result(row_id: str, f: Finding, lease_token: str) -> dict:
    return {
        "id": row_id,
        "leaseToken": lease_token,
        "researchComplete": f.research_complete,
        **({"retryAfter": f.retry_after} if f.retry_after else {}),
        "status": "RETRY" if f.retry_after else (f.status if not (f.notes and f.notes[0].startswith("error:")) else "FAILED"),
        "email": f.email,
        "emailType": f.email_type,
        "confidence": f.confidence or None,
        "sourceUrl": f.source_url if f.source_url and len(f.source_url) <= 1000 else None,
        "decisionMaker": f.decision_maker[:200] if f.decision_maker else None,
        "contactFormUrl": f.contact_form_url if f.contact_form_url and len(f.contact_form_url) <= 1000 else None,
        "notes": "; ".join(f.notes)[:1000] or None,
    }


async def run() -> None:
    settings = load_settings()
    if not settings.worker_token:
        log.error("EMAIL_FINDER_WORKER_TOKEN is missing from the repo's .env; nothing to do.")
        return

    if settings.google_api_key and not settings.google_cx:
        log.info("Google search key present, but search-engine ID missing; using Brave fallback.")
    # Fail at startup with a useful diagnosis rather than failing every row.
    try:
        await asyncio.to_thread(nlp.nlp)
    except Exception:
        log.error("spaCy English model unavailable. Run setup-email-finder.ps1.")
        return

    cache = Cache()
    fetcher = Fetcher(
        cache,
        settings.per_host_delay,
        settings.use_browser,
        chrome_profile_path=settings.chrome_profile_path,
        browser_cdp_url=settings.browser_cdp_url,
    )
    search = BraveSearch.from_settings(settings, cache)
    if search.enabled:
        providers = ", ".join(p[0] for p in search.providers)
    else:
        providers = "disabled"
    engine = Engine(fetcher, search, DomainChecker(cache), settings.max_site_pages)
    log.info("Scoring weights loaded: decision=%s own_domain=%s free_mail_with_own=%s minimum=%s",
             engine.scoring.decision_bonus, engine.scoring.own_domain_bonus,
             engine.scoring.free_mail_with_own_bonus, engine.scoring.minimum_score)
    api = Api(settings.api_base, settings.worker_token)
    form_sender = FormSender(fetcher, CACHE_DIR.parent / "form-answers.json")
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

    async def flush_outbox() -> None:
        for key, item in cache.items("outbox-v2"):
            try:
                if item["kind"] == "research":
                    await api.submit([item["result"]])
                else:
                    await api.form_result(item["result"])
                cache.delete("outbox-v2", key)
            except httpx.HTTPError:
                log.warning("Result delivery pending; saved locally for retry.")
                break

    async def research(item: dict) -> None:
        if not item.get("leaseToken"):
            log.error("API is outdated: deploy the email finder recovery migration and API build.")
            return
        row = to_row(item["input"])
        try:
            finding = await asyncio.wait_for(engine.find(row), timeout=settings.row_timeout)
        except asyncio.TimeoutError:
            finding = Finding(notes=["Research time limit reached; will resume using cached pages"], retry_after=1800, research_complete=False)
        log.info("Research finished: %s (%s)", finding.status, finding.email_type or "unresolved")
        result = to_result(item["id"], finding, item["leaseToken"])
        cache.set("outbox-v2", item["id"], {"kind": "research", "result": result}, 365 * 86400)
        await flush_outbox()

    async def form_loop() -> None:
        while not stop.is_set():
            try:
                for task in await api.claim_forms():
                    result = await form_sender.send(task, lambda: api.arm_form(task))
                    receipt = {"id": task["id"], "leaseToken": task["leaseToken"], "status": result.status, "notes": result.notes[:500]}
                    cache.set("outbox-v2", "form:" + task["id"], {"kind": "form", "result": receipt}, 365 * 86400)
                    await flush_outbox()
            except httpx.HTTPError:
                log.warning("Contact-form queue unavailable; retrying later.")
            await _sleep(stop, 30)

    beat = asyncio.create_task(heartbeat_loop())
    forms = asyncio.create_task(form_loop())
    backoff = IDLE_POLL_SECONDS
    log.info("Email finder worker started: %d concurrent rows; search providers: %s",
             settings.concurrency, providers)
    try:
        while not stop.is_set():
            try:
                await flush_outbox()
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
                await _sleep(stop, backoff)
                continue
            await asyncio.gather(*(research(item) for item in batch))
    finally:
        stop.set()
        beat.cancel()
        forms.cancel()
        await asyncio.gather(beat, forms, return_exceptions=True)
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
    lockfile = (CACHE_DIR / "worker.lock").open("a+b")
    if os.name == "nt":
        import msvcrt
        import ctypes
        from ctypes import wintypes
        try:
            lockfile.seek(0)
            msvcrt.locking(lockfile.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            log.info("Another email finder is already running.")
            return
        kernel = ctypes.windll.kernel32
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.SetPriorityClass.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel.SetPriorityClass(kernel.GetCurrentProcess(), 0x4000)

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
