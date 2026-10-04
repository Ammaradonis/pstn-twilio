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
import subprocess
import sys
import time
from pathlib import Path

import httpx

from .cache import Cache
from .config import CACHE_DIR, load_settings
from .engine import Engine, Finding, Row
from .fetch import Fetcher
from .forms import FormSender
from .android import Galaxy, find_adb
from .google_free import GoogleFreeSearch
from . import nlp
from .search import BraveSearch
from .validate import DomainChecker

log = logging.getLogger("email_finder.worker")
IDLE_POLL_SECONDS = 20
HEARTBEAT_SECONDS = 45
CACHE_MAINTENANCE_SECONDS = 3600
PACKAGE_DIR = Path(__file__).resolve().parent
# A restart waits until the code has been unchanged this long (an edit or
# git pull in progress shouldn't restart the worker halfway through).
CODE_SETTLE_SECONDS = 30


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
        "method": f.method[:200] if f.method and f.email else None,
        **({"enrichment": f.enrichment} if f.enrichment else {}),
    }


def code_stamp() -> tuple[tuple[str, int], ...]:
    """Names and modification times of the worker's code and scoring file."""
    files = [*PACKAGE_DIR.glob("*.py"), PACKAGE_DIR / "scoring-parameters.json"]
    return tuple(sorted((f.name, f.stat().st_mtime_ns) for f in files if f.exists()))


def new_code_ready(started: tuple[tuple[str, int], ...], rejected: set) -> bool:
    """True when the code on disk changed, has settled, and imports cleanly.

    The worker used to keep running code from before a git pull for days, and
    the API (deployed separately) then rejected every result it posted.
    """
    now = code_stamp()
    if now == started or now in rejected:
        return False
    if time.time() - max(mtime for _, mtime in now) / 1e9 < CODE_SETTLE_SECONDS:
        return False
    check = subprocess.run(
        [sys.executable, "-c", "import email_finder.worker"],
        cwd=PACKAGE_DIR.parent, capture_output=True, text=True, timeout=300,
    )
    if check.returncode != 0:
        log.error("Worker code changed but doesn't import; keeping the running version. %s",
                  (check.stderr.strip().splitlines() or [""])[-1])
        rejected.add(now)
        return False
    return True


async def run() -> bool:
    """Process rows until stopped. True means restart to load new code."""
    settings = load_settings()
    if not settings.worker_token:
        log.error("EMAIL_FINDER_WORKER_TOKEN is missing from the repo's .env; nothing to do.")
        return False

    if settings.google_api_key and not settings.google_cx:
        log.info("Google search key present, but search-engine ID missing; using Brave fallback.")
    # Fail at startup with a useful diagnosis rather than failing every row.
    try:
        await asyncio.to_thread(nlp.nlp)
    except Exception:
        log.error("spaCy English model unavailable. Run setup-email-finder.ps1.")
        return False

    cache = Cache()
    await asyncio.to_thread(cache.maintain, True)
    fetcher = Fetcher(
        cache,
        settings.per_host_delay,
        settings.use_browser,
        chrome_profile_path=settings.chrome_profile_path,
        browser_cdp_url=settings.browser_cdp_url,
        social_cookies={"facebook": settings.facebook_cookies, "instagram": settings.instagram_cookies},
        social_daily_limit=settings.social_daily_limit,
    )
    signed = [n for n, f in (("Facebook", settings.facebook_cookies), ("Instagram", settings.instagram_cookies)) if f]
    if signed:
        log.info("Social research signs in to %s with your exported cookies", " and ".join(signed))
    search = BraveSearch.from_settings(settings, cache)
    if search.enabled:
        providers = ", ".join(p[0] for p in search.providers)
    else:
        providers = "disabled"
    google = None
    if settings.google_free != "off" and settings.google_free_daily_limit > 0:
        # Its own Playwright driver: the fetcher's browser shutdown stops the
        # shared driver, which used to abort a search mid-query.
        google = GoogleFreeSearch(cache, daily_limit=settings.google_free_daily_limit,
                                  use_browser=settings.use_browser, cookies_file=settings.google_cookies,
                                  cse_id=settings.google_cx, cse_daily_limit=settings.cse_daily_limit)
        rows = "rows with no website or social profile" if settings.google_free == "bare" else "every row"
        how = f" (signed in via {settings.google_cookies.name})" if settings.google_cookies else ""
        providers = f"free Google{how} first for {rows}, then {providers}"
    galaxy = None
    adb = find_adb() if settings.galaxy else None
    if adb:
        galaxy = Galaxy(cache, adb, settings.galaxy_serial, settings.galaxy_daily_limit,
                        ambient=settings.ambient)
        ready = await galaxy.available()
        log.info("Galaxy A20e backup for Facebook/Instagram: %s", "ready" if ready else
                 "not connected or locked right now (checked again before each use)")
    engine = Engine(fetcher, search, DomainChecker(cache), settings.max_site_pages,
                    google=google, google_mode=settings.google_free, galaxy=galaxy)
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
            except httpx.HTTPStatusError as err:
                code = err.response.status_code
                if 400 <= code < 500 and code not in (401, 408, 429):
                    # Resending can't fix a rejected result, and it would hold up
                    # every result queued behind it. The row's lease expires and
                    # the row is researched again.
                    log.error("API rejected a result (HTTP %s): %s", code, err.response.text[:500])
                    cache.delete("outbox-v2", key)
                    continue
                log.warning("Result delivery pending (HTTP %s); saved locally for retry.", code)
                break
            except httpx.HTTPError:
                log.warning("Result delivery pending; saved locally for retry.")
                break

    async def research(item: dict) -> None:
        try:
            await research_row(item)
        except Exception:  # noqa: BLE001
            # The row's lease expires and it is researched again; the worker,
            # and the other rows in the batch, carry on.
            log.exception("research failed for row %s", item.get("id"))

    async def research_row(item: dict) -> None:
        if not item.get("leaseToken"):
            log.error("API is outdated: deploy the email finder recovery migration and API build.")
            return
        row = to_row(item["input"])
        try:
            finding = await asyncio.wait_for(engine.find(row), timeout=settings.row_timeout)
        except asyncio.TimeoutError:
            finding = Finding(notes=["Research time limit reached; will resume using cached pages"], retry_after=1800, research_complete=False)
        log.info("Research finished: %s (%s)%s", finding.status, finding.email_type or "unresolved",
                 f" — {finding.method}" if finding.method else "")
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
    if galaxy is not None and galaxy.start_ambient():
        caps = ", ".join(f"{name} {getattr(settings.ambient, field)}/day"
                         for name, field in (("likes", "likes_per_day"), ("follows", "follows_per_day"),
                                             ("interest", "interests_per_day"))
                         if getattr(settings.ambient, name.rstrip("s"), True))
        log.info("Ambient Reels session on the Galaxy A20e (%s); quiet hours %s; a security check "
                 "stops the phone for %d h.", caps or "no engagement",
                 f"{settings.ambient.quiet_hours[0]:02d}:00-{settings.ambient.quiet_hours[1]:02d}:00"
                 if settings.ambient.quiet_hours else "none", settings.ambient.cap_hours)
    backoff = IDLE_POLL_SECONDS
    started_code, rejected_code = code_stamp(), set()
    restart = False
    maintained_at = time.monotonic()
    log.info("Email finder worker started: %d concurrent rows; search providers: %s",
             settings.concurrency, providers)
    try:
        while not stop.is_set():
            if time.monotonic() - maintained_at > CACHE_MAINTENANCE_SECONDS:
                await asyncio.to_thread(cache.maintain)
                maintained_at = time.monotonic()
            # Between batches, so nothing claimed is abandoned.
            if await asyncio.to_thread(new_code_ready, started_code, rejected_code):
                log.info("Worker code changed on disk; restarting to load it.")
                restart = True
                break
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
            except Exception:  # noqa: BLE001
                log.exception("worker loop error; retrying shortly")
                batch, backoff = [], min(backoff * 2, 300)
            if not batch:
                if google:
                    await google.close_idle()
                await _sleep(stop, backoff)
                continue
            await asyncio.gather(*(research(item) for item in batch))
    finally:
        stop.set()
        beat.cancel()
        forms.cancel()
        if galaxy is not None:
            await galaxy.stop_ambient()
        await asyncio.gather(beat, forms, return_exceptions=True)
        await api.close()
        if google:
            await google.close()
        await fetcher.close()
        await search.close()
        log.info("email finder worker stopped")
    return restart


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
            # Normal: the scheduled task re-launches every 10 minutes as a watchdog.
            return
        kernel = ctypes.windll.kernel32
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        kernel.SetPriorityClass.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel.SetPriorityClass(kernel.GetCurrentProcess(), 0x4000)

    try:
        restart = asyncio.run(run())
    except KeyboardInterrupt:
        restart = False
    except Exception:
        log.exception("email finder worker crashed; the scheduled task restarts it")
        raise
    if restart:
        lockfile.close()  # releases the single-instance lock for the new process
        args = [sys.executable, "-m", "email_finder.worker"]
        if os.name == "nt":
            subprocess.Popen(
                args, cwd=PACKAGE_DIR.parent, close_fds=True,
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
            )
        else:
            os.chdir(PACKAGE_DIR.parent)
            os.execv(sys.executable, args)


if __name__ == "__main__":
    main()
