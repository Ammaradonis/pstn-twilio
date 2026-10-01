"""Polite page fetching.

Identifies itself honestly, follows robots.txt, spaces out requests to the
same host, caps page size and time. JavaScript-only pages can be rendered in
a plain headless Chrome (no login, no profile, nothing disguised).
"""

from __future__ import annotations

import asyncio
import logging
import time
import urllib.robotparser
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from .cache import Cache

log = logging.getLogger(__name__)

USER_AGENT = (
    "Mozilla/5.0 (compatible; BestSoftphoneEmailFinder/1.0; +https://bestsoftphone.site)"
)
MAX_BYTES = 2_500_000
PAGE_TTL = 7 * 24 * 3600


@dataclass
class Page:
    url: str
    status: int
    html: str
    final_url: str


class Fetcher:
    def __init__(self, cache: Cache, per_host_delay: float = 1.5, use_browser: bool = True) -> None:
        self.cache = cache
        self.per_host_delay = per_host_delay
        self.use_browser = use_browser
        self._client = httpx.AsyncClient(
            headers={"User-Agent": USER_AGENT, "Accept-Language": "en-GB,en;q=0.9"},
            follow_redirects=True,
            timeout=httpx.Timeout(15.0, connect=8.0),
            limits=httpx.Limits(max_connections=20),
        )
        self._host_locks: dict[str, asyncio.Lock] = {}
        self._host_last: dict[str, float] = {}
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
        self._browser = None
        self._browser_lock = asyncio.Lock()
        self._browser_last_used = 0.0

    async def close(self) -> None:
        await self._client.aclose()
        await self._close_browser()

    # ── robots.txt ───────────────────────────────────────────────────────────

    async def allowed(self, url: str) -> bool:
        parts = urlsplit(url)
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in self._robots:
            parser: urllib.robotparser.RobotFileParser | None = urllib.robotparser.RobotFileParser()
            try:
                res = await self._client.get(origin + "/robots.txt", timeout=8.0)
                if res.status_code == 200:
                    parser.parse(res.text.splitlines())
                elif res.status_code in (401, 403):
                    parser.parse(["User-agent: *", "Disallow: /"])
                else:
                    parser = None  # no robots.txt: everything allowed
            except httpx.HTTPError:
                parser = None
            self._robots[origin] = parser
        parser = self._robots[origin]
        return parser is None or parser.can_fetch(USER_AGENT, url)

    # ── fetching ─────────────────────────────────────────────────────────────

    async def get(self, url: str) -> Page | None:
        cached = self.cache.get("page", url)
        if cached is not None:
            return Page(**cached) if cached else None
        if not await self.allowed(url):
            log.debug("robots.txt disallows %s", url)
            self.cache.set("page", url, {}, PAGE_TTL)
            return None
        host = urlsplit(url).netloc.lower()
        lock = self._host_locks.setdefault(host, asyncio.Lock())
        async with lock:
            wait = self._host_last.get(host, 0) + self.per_host_delay - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                page = await self._download(url)
            finally:
                self._host_last[host] = time.monotonic()
        self.cache.set("page", url, page.__dict__ if page else {}, PAGE_TTL)
        return page

    async def _download(self, url: str) -> Page | None:
        try:
            async with self._client.stream("GET", url) as res:
                ctype = res.headers.get("content-type", "")
                if res.status_code >= 400 or ("html" not in ctype and "text" not in ctype):
                    return None
                chunks: list[bytes] = []
                size = 0
                async for chunk in res.aiter_bytes():
                    chunks.append(chunk)
                    size += len(chunk)
                    if size > MAX_BYTES:
                        break
                html = b"".join(chunks).decode(res.encoding or "utf-8", errors="replace")
                return Page(url=url, status=res.status_code, html=html, final_url=str(res.url))
        except (httpx.HTTPError, UnicodeError) as err:
            log.debug("fetch failed %s: %s", url, err)
            return None

    # ── headless Chrome for JavaScript-built pages ───────────────────────────

    async def render(self, url: str) -> Page | None:
        """Visible page text after scripts run, as a visitor's browser shows it."""
        if not self.use_browser or not await self.allowed(url):
            return None
        cached = self.cache.get("render", url)
        if cached is not None:
            return Page(**cached) if cached else None
        async with self._browser_lock:  # one page at a time: low-memory machine
            try:
                browser = await self._ensure_browser()
                context = await browser.new_context()
                page = await context.new_page()
                await page.goto(url, wait_until="domcontentloaded", timeout=20_000)
                await page.wait_for_timeout(2_000)
                html = await page.content()
                final = page.url
                await context.close()
                self._browser_last_used = time.monotonic()
                result = Page(url=url, status=200, html=html, final_url=final)
            except Exception as err:  # noqa: BLE001 - any browser failure just means "no page"
                log.debug("render failed %s: %s", url, err)
                result = None
        self.cache.set("render", url, result.__dict__ if result else {}, PAGE_TTL)
        return result

    async def _ensure_browser(self):
        if self._browser is None:
            from playwright.async_api import async_playwright

            self._pw = await async_playwright().start()
            try:
                # The PC's installed Chrome; no profile, so no logins or cookies.
                self._browser = await self._pw.chromium.launch(channel="chrome", headless=True)
            except Exception:  # noqa: BLE001
                self._browser = await self._pw.chromium.launch(headless=True)
        return self._browser

    async def close_idle_browser(self, idle_seconds: float = 120) -> None:
        if self._browser and time.monotonic() - self._browser_last_used > idle_seconds:
            await self._close_browser()

    async def _close_browser(self) -> None:
        if self._browser is not None:
            await self._browser.close()
            await self._pw.stop()
            self._browser = None
