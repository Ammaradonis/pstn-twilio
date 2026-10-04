"""Bounded HTTP and browser reads, with isolated sessions and challenge reporting.

Anti-detection notes
--------------------
* HTTP requests rotate through several realistic User-Agent strings (Chrome,
  Firefox, Safari) so that any single UA is never hammered.
* Per-host request pacing is randomised ±30 % of the configured delay.
* Playwright contexts use the iPhone 12 viewport + UA for Instagram and
  Facebook so that the "Contact" button (and the email address behind it)
  is actually rendered — desktop web hides it.
"""
from __future__ import annotations
import asyncio
import logging
import random
import re
import time
import urllib.robotparser
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urljoin, urlsplit, parse_qs, urlencode

import httpx
from .cache import Cache
from .config import CACHE_DIR
from .urls import public_url

log = logging.getLogger(__name__)

# Rotate between realistic browser strings so any single UA is not hammered.
_USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
]

# iPhone 12 UA — makes Instagram / Facebook render the mobile layout with the
# "Contact" button that shows the email address.
_IPHONE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1"
)
_IPHONE_VIEWPORT = {"width": 390, "height": 844}

USER_AGENT = _USER_AGENTS[0]  # kept for legacy callers
MAX_BYTES = 2_500_000
PAGE_TTL = 7 * 24 * 3600
CHALLENGE = re.compile(r"verify (?:that )?you are human|verify you.re human|checking your browser|"
                       r"just a moment.{0,30}cloudflare|cf-chl-|challenge-platform|"
                       r"please complete the security check|unusual traffic from your", re.I)

@dataclass
class Page:
    url: str
    status: int
    html: str
    final_url: str
    blocked: bool = False
    # How the page was fetched: "" plain HTTP, "browser" rendered, "iphone"
    # logged-in iPhone emulation, "desktop" logged-in desktop browser.
    via: str = ""

class Fetcher:
    def __init__(self, cache: Cache, per_host_delay: float = 1.5, use_browser: bool = True,
                 chrome_profile_path: str | None = None, browser_cdp_url: str | None = None,
                 max_connections: int = 12) -> None:
        self.cache, self.per_host_delay, self.use_browser = cache, per_host_delay, use_browser
        self.chrome_profile_path = chrome_profile_path
        self.browser_cdp_url = browser_cdp_url
        self._ua_cycle = iter(_USER_AGENTS * 100)  # rotate UA across requests
        self._client = httpx.AsyncClient(
            headers={
                "User-Agent": random.choice(_USER_AGENTS),
                "Accept-Language": "en-US,en;q=0.9",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Encoding": "gzip, deflate, br",
                "DNT": "1",
            },
            follow_redirects=False, timeout=httpx.Timeout(15, connect=8),
            limits=httpx.Limits(max_connections=max(1, min(32, max_connections))))
        self._host_locks: dict[str, asyncio.Lock] = {}
        self._host_last: dict[str, float] = {}
        self._robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
        self._browser = self._social_context = self._pw = self._attached = None
        self._browser_lock = asyncio.Lock()
        self._social_context_lock = asyncio.Lock()
        self._pw_lock = asyncio.Lock()
        # Stopping Playwright disconnects everything using the driver. Another
        # component can lend it (hold_driver) so a shutdown here waits instead
        # of tearing the ground out from under a running page.
        self._pw_guard = asyncio.Lock()
        self._pw_lease = 0
        self._pw_free = asyncio.Event()
        self._pw_free.set()
        self._browser_last_used = time.monotonic()

    async def hold_driver(self) -> None:
        """Lend the Playwright driver: it is not stopped until release_driver()."""
        async with self._pw_guard:
            self._pw_lease += 1
            self._pw_free.clear()

    async def release_driver(self) -> None:
        async with self._pw_guard:
            self._pw_lease = max(0, self._pw_lease - 1)
            if not self._pw_lease:
                self._pw_free.set()

    async def close(self) -> None:
        await self._client.aclose()
        await self._close_browser()

    async def allowed(self, url: str) -> bool:
        if not await public_url(url):
            return False
        p = urlsplit(url)
        origin = f"{p.scheme}://{p.netloc}"
        if origin not in self._robots:
            parser = urllib.robotparser.RobotFileParser()
            try:
                res = await self._client.get(origin + "/robots.txt", timeout=8)
                if res.status_code == 200:
                    parser.parse(res.text[:100_000].splitlines())
                elif res.status_code in (401, 403, 429) or res.status_code >= 500:
                    parser.parse(["User-agent: *", "Disallow: /"])
                else:
                    parser = None
            except httpx.HTTPError:
                # Transient site failure: do not turn it into a week-long cached rejection.
                return False
            self._robots[origin] = parser
        parser = self._robots[origin]
        return parser is None or parser.can_fetch(USER_AGENT, url)

    async def _pace(self, host: str) -> None:
        # Randomise delay ±30 % to avoid mechanical fingerprinting.
        jitter = self.per_host_delay * random.uniform(0.7, 1.3)
        wait = self._host_last.get(host, 0) + jitter - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        self._host_last[host] = time.monotonic()

    async def get(self, url: str) -> Page | None:
        cached = self.cache.get("page-v2", url)
        if cached is not None:
            return Page(**cached)
        if not await self.allowed(url):
            return None
        host = urlsplit(url).netloc.lower()
        async with self._host_locks.setdefault(host, asyncio.Lock()):
            # Another row may have fetched this URL while this row was waiting.
            cached = self.cache.get("page-v2", url)
            if cached is not None:
                return Page(**cached)
            await self._pace(host)
            page = await self._download(url)
        if page and not page.blocked:
            self.cache.set("page-v2", url, page.__dict__, PAGE_TTL)
        return page

    async def _download(self, url: str) -> Page | None:
        target = url
        # Rotate UA per request for anti-fingerprinting.
        ua = next(self._ua_cycle, None) or random.choice(_USER_AGENTS)
        try:
            for _ in range(6):
                if not await self.allowed(target):
                    return None
                async with self._client.stream("GET", target, headers={"User-Agent": ua}) as res:
                    if res.is_redirect:
                        target = urljoin(target, res.headers.get("location", ""))
                        continue
                    if res.status_code in (403, 429):
                        return Page(url, res.status_code, "", target, True)
                    ctype = res.headers.get("content-type", "")
                    if res.status_code >= 400 or not any(t in ctype for t in ("html", "text")):
                        return None
                    chunks, size = [], 0
                    async for chunk in res.aiter_bytes():
                        size += len(chunk)
                        if size > MAX_BYTES:
                            return None
                        chunks.append(chunk)
                    html = b"".join(chunks).decode(res.encoding or "utf-8", errors="replace")
                    return Page(url, res.status_code, html, str(res.url), bool(CHALLENGE.search(html)))
        except (httpx.HTTPError, UnicodeError, ValueError):
            return None
        return None

    async def guard_page(self, page) -> None:
        # Browser resources and redirects are also untrusted; never send local credentials.
        decisions: dict[str, bool] = {}
        async def route(request_route):
            request = request_route.request
            if request.url.startswith(("data:", "blob:")):
                await request_route.continue_()
                return
            p = urlsplit(request.url)
            origin = f"{p.scheme}://{p.netloc}"
            if origin not in decisions:
                decisions[origin] = await public_url(origin)
            if not decisions[origin]:
                await request_route.abort()
            elif request.resource_type in ("image", "media", "font"):
                await request_route.abort()
            else:
                await request_route.continue_()
        await page.route("**/*", route)

    async def render(self, url: str) -> Page | None:
        if not self.use_browser or not await self.allowed(url):
            return None
        cached = self.cache.get("render-v2", url)
        if cached is not None:
            return Page(**{**cached, "via": "browser"})
        context = None
        async with self._browser_lock:
            try:
                browser = await self._ensure_browser()
                context = await browser.new_context(locale="en-GB", service_workers="block")
                page = await context.new_page()
                await self.guard_page(page)
                await self._pace(urlsplit(url).netloc)
                response = await page.goto(url, wait_until="domcontentloaded", timeout=20_000)
                await page.wait_for_timeout(1500)
                html = (await page.content())[:MAX_BYTES]
                result = Page(url, response.status if response else 200, html, page.url,
                              bool(CHALLENGE.search(html)) or bool(response and response.status in (403, 429)),
                              via="browser")
                if not result.blocked:
                    self.cache.set("render-v2", url, result.__dict__, PAGE_TTL)
                return result
            except Exception:
                log.debug("Browser rendering unavailable")
                return None
            finally:
                if context:
                    await context.close()
                self._browser_last_used = time.monotonic()

    async def _ensure_playwright(self):
        async with self._pw_lock:
            if self._pw is None:
                from playwright.async_api import async_playwright
                self._pw = await async_playwright().start()
        return self._pw

    async def _ensure_browser(self):
        if self._browser is None:
            pw = await self._ensure_playwright()
            self._browser = await pw.chromium.launch(headless=True)
        return self._browser

    async def _ensure_social_context(self):
        if self._social_context is not None:
            return self._social_context
        pw = await self._ensure_playwright()
        if self.browser_cdp_url:
            p = urlsplit(self.browser_cdp_url)
            if p.hostname not in ("localhost", "127.0.0.1", "::1"):
                raise ValueError("Browser debugging must be local to this PC")
            self._attached = await pw.chromium.connect_over_cdp(self.browser_cdp_url)
            self._social_context = self._attached.contexts[0]
        else:
            profile = Path(self.chrome_profile_path) if self.chrome_profile_path else CACHE_DIR / "browser-profile"
            # Main Chrome/Edge profiles cannot be automated safely alongside calls.
            if profile.name.lower() in ("user data", "default") or re.search(r"[\\/]User Data[\\/]Profile \d+$", str(profile), re.I):
                raise ValueError("Configure a dedicated browser profile or a local CDP session")
            self._social_context = await pw.chromium.launch_persistent_context(
                str(profile), headless=True, locale="en-GB", service_workers="block",
            )
        return self._social_context

    async def fetch_fb_profile(self, url: str) -> Page | None:
        """Fetch a Facebook profile's About / Contact Info tab.

        Strategy (mobile-first, as FB hides email on desktop):
          1. Try the dedicated /about_contact_and_basic_info URL with iPhone mobile
             emulation — this is the highest-yield path.  FB's desktop web strips
             the "Email" field; the iPhone layout renders it.
          2. Click "Contact info", "See contact info", "Info", "About", "Email",
             "Contact", "More Info" buttons/links if present.
          3. Fall back to the plain /about page with desktop social context.
          4. Last resort: m.facebook.com/<username>/about
        """
        about_url = _fb_about_url(url)

        # All the label variants FB uses for contact-info panels — ordered by
        # how directly they reveal an email address.
        fb_labels = (
            "Contact info",
            "Contact Info",
            "See contact info",
            "Email",
            "Info",
            "About",
            "Contact",
            "More Info",
            "Contact and basic info",
            "Contact and Basic Info",
        )

        # Step 1: iPhone mobile emulation (highest yield — always try this first).
        mobile = await self._social_mobile(about_url, fb_labels)
        if mobile and not mobile.blocked and re.search(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}", mobile.html):
            return mobile

        # Step 2: Desktop social context (may work for some profiles).
        desktop = await self._social(about_url, fb_labels)
        if desktop and not desktop.blocked and re.search(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}", desktop.html):
            return desktop

        # Step 3: m.facebook.com/<username>/about — the classic mobile site.
        m_url = about_url.replace("www.facebook.com", "m.facebook.com")
        if m_url != about_url:
            m_result = await self._social_mobile(m_url, fb_labels)
            if m_result and not m_result.blocked and re.search(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}", m_result.html):
                return m_result

        # Return whatever partial result we have (engine will still parse bio text).
        return mobile or desktop

    async def fetch_ig_profile(self, url: str) -> Page | None:
        """Fetch an Instagram profile using iPhone mobile emulation.

        Desktop Instagram does not render the 'Contact' button that reveals the
        email address stored in the business profile. iPhone device emulation
        (390 × 844, Mobile Safari UA) causes Instagram to serve the mobile
        layout where the 'Email' / 'Contact' button is always visible.

        Strategy:
          1. Try iPhone mobile emulation with the logged-in social context.
          2. Click 'Email', 'Contact', or 'Contact options' button to expand
             the contact sheet that lists the email.
          3. Also read the bio text which sometimes contains a plain email.
          4. Fall back to the desktop-UA social fetch if mobile emulation fails.
        """
        # Primary: iPhone emulation
        result = await self._social_mobile(url, ("Email", "Contact", "Contact options"))
        if result and not result.blocked:
            return result
        # Fallback: desktop social context
        return await self._social(url, ("Contact", "Contact options", "Email"))

    async def _social_mobile(self, url: str, labels: tuple[str, ...]) -> Page | None:
        """Open a page in the logged-in social context but with iPhone viewport + UA."""
        if not self.use_browser or not await public_url(url):
            return None
        cache_key = "mobile:" + url
        cached = self.cache.get("social-v2", cache_key)
        if cached is not None:
            return Page(**{**cached, "via": "iphone"})
        page = None
        async with self._social_context_lock:
            try:
                ctx = await self._ensure_social_context()
                # Create a new page with iPhone emulation overrides
                page = await ctx.new_page()
                await page.set_viewport_size(_IPHONE_VIEWPORT)
                await page.set_extra_http_headers({
                    "User-Agent": _IPHONE_UA,
                    "Accept-Language": "en-US,en;q=0.9",
                })
                await self.guard_page(page)
                await self._pace(urlsplit(url).netloc)
                await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
                await page.wait_for_timeout(2000)
                # Click contact-reveal buttons
                for label in labels:
                    for btn in [
                        page.get_by_role("button", name=label, exact=True),
                        page.get_by_role("link", name=label, exact=True),
                        page.locator(f"a:has-text('{label}'), button:has-text('{label}')"),
                    ]:
                        if await btn.count() and await btn.first.is_visible():
                            try:
                                await btn.first.click(timeout=3000)
                                await page.wait_for_timeout(800)
                            except Exception:
                                pass
                            break
                html = (await page.content())[:MAX_BYTES]
                blocked = (
                    bool(await page.locator("input[type=password]").count())
                    or bool(CHALLENGE.search(html))
                    or bool(re.search(r"/(login|accounts/login|checkpoint)", page.url))
                )
                result = Page(url, 200, html, page.url, blocked, via="iphone")
                if not blocked and ("mailto:" in html or re.search(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}", html)):
                    self.cache.set("social-v2", cache_key, result.__dict__, 24 * 3600)
                return result
            except Exception:
                log.debug("Mobile social profile unavailable")
                return None
            finally:
                if page:
                    await page.close()
                self._browser_last_used = time.monotonic()

    async def _social(self, url: str, labels: tuple[str, ...]) -> Page | None:
        if not self.use_browser or not await public_url(url):
            return None
        cached = self.cache.get("social-v2", url)
        if cached is not None:
            return Page(**{**cached, "via": "desktop"})
        page = None
        async with self._social_context_lock:
            try:
                ctx = await self._ensure_social_context()
                page = await ctx.new_page()
                await self.guard_page(page)
                await self._pace(urlsplit(url).netloc)
                await page.goto(url, wait_until="domcontentloaded", timeout=25_000)
                await page.wait_for_timeout(1500)
                for label in labels:
                    button = page.get_by_role("button", name=label, exact=True)
                    if await button.count() and await button.first.is_visible():
                        await button.first.click(timeout=2500)
                        await page.wait_for_timeout(500)
                html = (await page.content())[:MAX_BYTES]
                blocked = bool(await page.locator("input[type=password]").count()) or bool(CHALLENGE.search(html)) or bool(re.search(r"/(login|accounts/login|checkpoint)", page.url))
                result = Page(url, 200, html, page.url, blocked, via="desktop")
                if not blocked and ("mailto:" in html or re.search(r"[\w.+-]+@[\w.-]+\.[a-z]{2,}", html)):
                    self.cache.set("social-v2", url, result.__dict__, 24 * 3600)
                return result
            except Exception:
                log.debug("Social profile unavailable; login/checkpoint may need attention")
                return None
            finally:
                if page:
                    await page.close()
                self._browser_last_used = time.monotonic()

    async def reveal_math(self, url: str) -> Page | None:
        """Only submit a dedicated arithmetic email-reveal form, never a contact message."""
        if not self.use_browser or not await self.allowed(url):
            return None
        context = None
        async with self._browser_lock:
            try:
                browser = await self._ensure_browser()
                context = await browser.new_context(service_workers="block")
                page = await context.new_page()
                await self.guard_page(page)
                await page.goto(url, wait_until="domcontentloaded", timeout=20_000)
                from .extract import extract_math_challenge
                for form in await page.locator("form").all():
                    text = await form.inner_text()
                    if not re.search(r"(reveal|show|see).{0,30}e-?mail", text, re.I):
                        continue
                    if await form.locator("textarea,input[type=email],input[type=password]").count():
                        continue
                    inputs = form.locator("input:not([type=hidden]):not([type=submit]):not([type=button])")
                    if await inputs.count() != 1:
                        continue
                    answer = extract_math_challenge(text)
                    if answer is None:
                        continue
                    await inputs.fill(str(answer))
                    submit = form.locator("button[type=submit],input[type=submit],button:not([type])")
                    if await submit.count() != 1:
                        continue
                    await submit.click(timeout=3000)
                    await page.wait_for_timeout(1000)
                    html = (await page.content())[:MAX_BYTES]
                    return Page(url, 200, html, page.url, bool(CHALLENGE.search(html)))
                return None
            except Exception:
                return None
            finally:
                if context:
                    await context.close()

    async def close_idle_browser(self, idle_seconds: float = 120) -> None:
        if time.monotonic() - self._browser_last_used > idle_seconds:
            await self._close_browser()

    async def _close_browser(self) -> None:
        # Wait for a lent driver: a component that is mid-page keeps working.
        # Bounded, so a lease that is never returned cannot hang a shutdown.
        try:
            await asyncio.wait_for(self._pw_free.wait(), timeout=60)
        except asyncio.TimeoutError:
            log.warning("Browser driver still lent after 60 s; shutting it down anyway")
        if self._social_context is not None and self._attached is None:
            await self._social_context.close()
        self._social_context = None
        if self._browser:
            await self._browser.close()
            self._browser = None
        # Stopping Playwright disconnects CDP without closing the user's browser or tabs.
        if self._pw:
            await self._pw.stop()
            self._pw = None
        self._attached = None

def _fb_about_url(url: str) -> str:
    p = urlsplit(url)
    host = "www.facebook.com"
    if p.path.rstrip("/") == "/profile.php":
        params = parse_qs(p.query)
        return f"https://{host}/profile.php?" + urlencode({"id": params.get("id", [""])[0], "sk": "about_contact_and_basic_info"})
    path = p.path.rstrip("/")
    path = re.sub(r"/(?:about(?:_contact_and_basic_info)?|info)$", "", path)
    # The /about_contact_and_basic_info sub-page directly shows email + phone.
    return f"https://{host}{path}/about_contact_and_basic_info"
