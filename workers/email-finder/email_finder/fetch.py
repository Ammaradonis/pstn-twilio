"""Bounded HTTP and browser reads, with isolated sessions and challenge reporting.

Anti-detection notes
--------------------
* HTTP requests rotate through several realistic User-Agent strings (Chrome,
  Firefox, Safari) so that any single UA is never hammered.
* Per-host request pacing is randomised ±30 % of the configured delay.
* Playwright contexts use the iPhone 12 viewport + UA for Instagram and
  Facebook so that the "Contact" button (and the email address behind it)
  is actually rendered — desktop web hides it.

Facebook and Instagram
----------------------
* The social browser is a real Edge/Chrome (browser.py) with its own profile in
  .cache/social-profile, signed in with the user's exported cookies
  (www.facebook.com_cookies.txt, www.instagram.com_cookies.txt in the repo
  root; cookies.py), each export loaded once.
* iPhone pages are emulated fully (browser.emulate_iphone), not just by
  swapping the user-agent header.
* Page loads are 12-25 s apart per platform, with a daily cap.
* When Meta pushes back, the platform is left alone instead of retried: a login
  wall (cookies expired) for 6 h or until a new export, a security checkpoint
  for 12 h, a CAPTCHA for 30 min doubling up to 8 h. Retrying through a
  checkpoint is how a soft block becomes a locked account. Nothing is solved.
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
from .browser import emulate_iphone, launch_persistent
from .cache import Cache
from .config import CACHE_DIR
from .cookies import FACEBOOK_HOSTS, INSTAGRAM_HOSTS, import_once
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

SOCIAL_HOSTS = {"facebook": FACEBOOK_HOSTS | {"fb.com"}, "instagram": INSTAGRAM_HOSTS}
SOCIAL_NAMES = {"facebook": "Facebook", "instagram": "Instagram"}
SOCIAL_GAP = (12.0, 25.0)  # seconds between page loads on one platform
# Instagram: how long a profile gets to show its Contact button before the page
# is refreshed once (and given the same time again).
IG_SETTLE_MS = 3000
# The profile's own Contact/Email button. Exact names only: the page footer has
# a "Contact Uploading & Non-Users" link that must never be clicked.
IG_CONTACT_NAMES = ("Contact", "Email", "Contact options")
IG_NOT_FOUND = re.compile(r"page isn.t available|user not found|link you followed may be broken", re.I)
SOCIAL_NS = "social-state"
# Pushback that retrying doesn't fix is left alone for a fixed time.
SOCIAL_PAUSE = {"login": 6 * 3600, "checkpoint": 12 * 3600}
FIRST_PAUSE, LONGEST_PAUSE = 30 * 60, 8 * 3600

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
                 max_connections: int = 12, social_cookies: dict[str, Path] | None = None,
                 social_daily_limit: int = 200) -> None:
        self.cache, self.per_host_delay, self.use_browser = cache, per_host_delay, use_browser
        self.chrome_profile_path = chrome_profile_path
        self.browser_cdp_url = browser_cdp_url
        # platform ("facebook" / "instagram") -> the user's cookies.txt export
        self.social_cookies = {k: v for k, v in (social_cookies or {}).items() if v}
        self.social_daily_limit = social_daily_limit
        # The configured folder; each browser gets its own copy (browser.profile_for).
        self._social_base = Path(chrome_profile_path) if chrome_profile_path else CACHE_DIR / "social-profile"
        self._social_profile = self._social_base  # the folder of the browser in use
        self._social_last: dict[str, float] = {}
        self._social_working: set[str] = set()
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
                elif res.status_code == 429 or res.status_code >= 500:
                    # RFC 9309: an unreachable robots.txt means "wait", while a
                    # 4xx (often a bot wall answering every URL) means no rules.
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

    async def guard_page(self, page, block_media: bool = True) -> None:
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
            elif block_media and request.resource_type in ("image", "media", "font"):
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
            profile = self._social_base
            # Main Chrome/Edge profiles cannot be automated safely alongside calls.
            if profile.name.lower() in ("user data", "default") or re.search(r"[\\/]User Data[\\/]Profile \d+$", str(profile), re.I):
                raise ValueError("Configure a dedicated browser profile or a local CDP session")
            self._social_context, channel, self._social_profile = await launch_persistent(
                pw, profile, locale="en-US", service_workers="block")
            log.info("Facebook/Instagram research uses %s", channel or "Playwright Chromium")
            for platform in self.social_cookies:
                await self._import_social_cookies(platform)
        return self._social_context

    # ── Facebook / Instagram session care ────────────────────────────────────

    def social_paused(self, platform: str) -> float:
        """Seconds until this platform may be asked again (0 = not paused)."""
        state = self.cache.get(SOCIAL_NS, f"{platform}-pause") or {}
        return max(0.0, float(state.get("until", 0)) - time.time())

    def _export_changed(self, platform: str) -> bool:
        path = self.social_cookies.get(platform)
        if not path or not path.is_file():
            return False
        stat = path.stat()
        stamp = self._social_profile / f".cookies-imported-{platform}"
        return not stamp.is_file() or stamp.read_text(encoding="utf-8").strip() != f"{stat.st_mtime_ns}:{stat.st_size}"

    async def _import_social_cookies(self, platform: str) -> None:
        if self._attached is not None or self._social_context is None:
            return  # an attached real browser is already signed in
        await import_once(self._social_context, self.social_cookies.get(platform), SOCIAL_HOSTS[platform],
                          self._social_profile, f".cookies-imported-{platform}")

    async def _social_turn(self, url: str) -> bool:
        """Whether a Facebook/Instagram page may be loaded now, after waiting out
        the gap between loads. False while the platform is paused or has used
        up today's page loads."""
        platform = social_platform(url)
        if platform is None:
            return True
        if self._export_changed(platform):
            # A fresh export is the fix for a login wall: use it straight away.
            self.cache.set(SOCIAL_NS, f"{platform}-pause", {"until": 0, "step": 0}, 30 * 86400)
            await self._import_social_cookies(platform)
        if self.social_paused(platform):
            return False
        if not self.cache.reserve(f"social-{platform}", self.social_daily_limit):
            log.info("%s page limit for today reached (EMAIL_FINDER_SOCIAL_DAILY_LIMIT)", SOCIAL_NAMES[platform])
            return False
        wait = self._social_last.get(platform, 0) + random.uniform(*SOCIAL_GAP) - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        self._social_last[platform] = time.monotonic()
        return True

    def _social_outcome(self, url: str, kind: str | None) -> None:
        """Record how Facebook/Instagram answered: pause it if it pushed back."""
        platform = social_platform(url)
        if platform is None:
            return
        name, key = SOCIAL_NAMES[platform], f"{platform}-pause"
        state = self.cache.get(SOCIAL_NS, key) or {}
        if kind is None:
            if state.get("step") or state.get("until"):
                self.cache.set(SOCIAL_NS, key, {"until": 0, "step": 0}, 30 * 86400)
            if platform not in self._social_working:
                self._social_working.add(platform)
                log.info("%s answered normally (signed-in session works)", name)
            return
        self._social_working.discard(platform)
        step = int(state.get("step", 0))
        if kind in SOCIAL_PAUSE:
            seconds = SOCIAL_PAUSE[kind]
        else:
            step = min(step + 1, 6)
            seconds = min(LONGEST_PAUSE, FIRST_PAUSE * 2 ** (step - 1))
        self.cache.set(SOCIAL_NS, key, {"until": time.time() + seconds, "step": step, "why": kind}, 30 * 86400)
        export = self.social_cookies.get(platform)
        advice = {
            "login": f"the cookies in {export.name if export else 'its cookies.txt export'} have expired or "
                     "were signed out; export them again and the worker picks them up by itself",
            "checkpoint": f"your account was asked for a security check; open {name} in your own browser "
                          "and complete it",
            "captcha": "it asked for a CAPTCHA (never solved here)",
        }[kind]
        log.warning("%s research paused for %d min: %s.", name, seconds // 60, advice)

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
        if (mobile and mobile.blocked) or self.social_paused("facebook"):
            return mobile  # Facebook pushed back: asking again in another layout only makes it worse

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
        """An Instagram profile in iPhone emulation, read the way a person would:

          1. Load it and give it IG_SETTLE_MS (3 s) to show its Contact button.
          2. Close Instagram's "Save your login info?" style prompts.
          3. Contact/Email button there: open it and read the address.
          4. Not there: refresh once and wait the same 3 s again.
          5. Open the bio ("more") and the link list ("... and 2 more"), so the
             engine sees the whole bio and every website the profile links to.

        Instagram's website (unlike its app) usually has no Contact button,
        so step 5 is what makes Instagram a real backup: the engine follows the
        profile's website and link-in-bio pages instead of giving up.
        """
        url = instagram_profile_url(url)
        result = await self._social_mobile(url, (), instagram=True)
        if result and not result.blocked:
            return result
        if (result and result.blocked) or self.social_paused("instagram"):
            return result  # Instagram pushed back: don't ask again in another layout
        # Fallback: desktop social context
        return await self._social(url, ("Contact", "Contact options", "Email"))

    async def _instagram_contact(self, page) -> bool:
        """Steps 1-4 of fetch_ig_profile; True when a Contact button was opened.
        "Sorry, this page isn't available" also gets the one refresh (golden
        rule: two tries), then the profile is left."""
        for attempt in range(2):
            await page.wait_for_timeout(IG_SETTLE_MS)
            await _dismiss_prompts(page)
            if await _ig_not_found(page):
                if attempt == 0:
                    await page.reload(wait_until="domcontentloaded", timeout=30_000)
                    continue
                return False
            for name in IG_CONTACT_NAMES:
                for button in (page.get_by_role("button", name=name, exact=True),
                               page.get_by_role("link", name=name, exact=True)):
                    if await button.count() and await button.first.is_visible():
                        try:
                            await button.first.click(timeout=3000)
                            await page.wait_for_timeout(1500)
                            return True
                        except Exception:  # noqa: BLE001 - covered or gone: keep looking
                            pass
            if attempt == 0:
                await page.reload(wait_until="domcontentloaded", timeout=30_000)
        return False

    async def _social_mobile(self, url: str, labels: tuple[str, ...], instagram: bool = False) -> Page | None:
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
                platform = social_platform(url)
                if platform and self.social_paused(platform) and not self._export_changed(platform):
                    return None  # no need to start the browser
                ctx = await self._ensure_social_context()
                if not await self._social_turn(url):
                    return None
                page = await ctx.new_page()
                await emulate_iphone(ctx, page)
                await self.guard_page(page, block_media=False)
                await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
                if instagram:
                    if await self._instagram_contact(page):
                        log.info("Instagram Contact button opened on %s", url)
                    await _reveal_instagram_profile(page)
                else:
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
                kind = block_kind(page.url, html, bool(await page.locator("input[type=password]").count()))
                self._social_outcome(url, kind)
                blocked = kind is not None
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
                platform = social_platform(url)
                if platform and self.social_paused(platform) and not self._export_changed(platform):
                    return None  # no need to start the browser
                ctx = await self._ensure_social_context()
                if not await self._social_turn(url):
                    return None
                page = await ctx.new_page()
                await self.guard_page(page, block_media=False)
                await page.goto(url, wait_until="domcontentloaded", timeout=25_000)
                await page.wait_for_timeout(1500)
                for label in labels:
                    button = page.get_by_role("button", name=label, exact=True)
                    if await button.count() and await button.first.is_visible():
                        await button.first.click(timeout=2500)
                        await page.wait_for_timeout(500)
                html = (await page.content())[:MAX_BYTES]
                kind = block_kind(page.url, html, bool(await page.locator("input[type=password]").count()))
                self._social_outcome(url, kind)
                blocked = kind is not None
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

def instagram_profile_url(url: str) -> str:
    """https://www.instagram.com/<handle>/ without share tokens (?stkn=...)
    or tracking parameters."""
    parts = urlsplit(url if "//" in url else "https://" + url)
    handle = parts.path.strip("/").split("/")[0]
    return f"https://www.instagram.com/{handle}/" if handle else url


async def _ig_not_found(page) -> bool:
    try:
        return bool(await page.get_by_text(IG_NOT_FOUND).count())
    except Exception:  # noqa: BLE001
        return False


async def _dismiss_prompts(page) -> None:
    """Close Instagram's "Save your login info?" / notifications prompts,
    which sit on top of the profile."""
    for name in ("Not now", "Not Now"):
        button = page.get_by_role("button", name=name, exact=True)
        try:
            if await button.count() and await button.first.is_visible():
                await button.first.click(timeout=2000)
                await page.wait_for_timeout(500)
        except Exception:  # noqa: BLE001
            pass


async def _reveal_instagram_profile(page) -> None:
    """Expand the bio ("more") and the profile's link list ("... and 2 more")."""
    for pattern in (r"^more$", r" and \d+ more$"):
        target = page.get_by_text(re.compile(pattern))
        try:
            count = await target.count()
            visible = bool(count) and await target.first.is_visible()
            log.debug("Instagram reveal %r: %d match(es), visible=%s", pattern, count, visible)
            if visible:
                try:
                    await target.first.click(timeout=3000)
                except Exception:  # noqa: BLE001 - something sits on top of it: click its button directly
                    await target.first.evaluate("e => (e.closest('[role=button],button,a') || e).click()")
                await page.wait_for_timeout(1000)
        except Exception as err:  # noqa: BLE001
            log.debug("Instagram reveal %r failed: %s", pattern, type(err).__name__)
    await _dismiss_prompts(page)


def social_platform(url: str) -> str | None:
    host = urlsplit(url if "//" in url else "https://" + url).netloc.lower().split(":")[0]
    for platform, hosts in SOCIAL_HOSTS.items():
        if host in hosts or any(host.endswith("." + h) for h in hosts):
            return platform
    return None


def block_kind(final_url: str, html: str, password_box: bool) -> str | None:
    """How Facebook/Instagram pushed back, if it did: "checkpoint" (a security
    check on the account), "login" (not signed in) or "captcha". Judged from the
    address and the page's own challenge markers, never from words in posts."""
    path = urlsplit(final_url).path.lower()
    if re.search(r"/(checkpoint|challenge|suspended|accounts/suspended)(/|$)", path):
        return "checkpoint"
    if re.search(r"/(login|accounts/login|recover)(/|\.php|$)", path) or password_box:
        return "login"
    if CHALLENGE.search(html):
        return "captcha"
    return None


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
