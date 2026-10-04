"""Free Google search with no API key, following
Google-search-engine-configuration-files/GOOGLE-FREE-SEARCH.txt.

The txt file's three pathways, as Google answers them in October 2026:
  1. Plain HTTP with a browser User-Agent (its Invoke-WebRequest recipe).
     Google now answers every client without JavaScript with "Update your
     browser", so this is probed at most once a week and used again
     automatically if Google brings the basic HTML page back.
  2. A real browser (its Start-Process recipe). Microsoft Edge, then Chrome,
     then Playwright's Chromium, launched by name rather than as "the default
     browser", headless, with a persistent profile in .cache/google-profile so
     cookies and the consent choice survive restarts. Queries are typed into
     the search box (see _ask).
  3. The Custom Search JSON API stays in search.py's chain.

Its edge cases:
  * Special characters: the query is URL-encoded (quote_plus).
  * CAPTCHA / "unusual traffic" / 429: never solved. Google search pauses for
    30 minutes, doubling up to 8 hours, and Brave takes over meanwhile.
  * Missing User-Agent: the browser's own user agent with the
    "HeadlessChrome" token removed. Nothing else about the browser is
    disguised: a user agent that contradicts the browser's other signals
    gets a CAPTCHA straight away.
  * Changing HTML: results are read from any link wrapping an <h3>, and
    Google's /goto and /url redirect links are resolved. A page with no
    readable results that doesn't say "no results" counts as a failure, not
    as an empty answer.
  * Quota: EMAIL_FINDER_GOOGLE_FREE_DAILY_LIMIT searches a day, 6-15 s apart.

Signed-in searching: when a cookies.txt export from the user's own browser is
configured (EMAIL_FINDER_GOOGLE_COOKIES, default <repo>/cookies.txt), its
google.com search cookies are loaded into the search profile, so Google sees a
long-lived signed-in session instead of a new anonymous one. Only cookies set
for google.com / www.google.com are read; the file's other sites (and
accounts.google.com, Gmail, Drive, Passwords...) are never loaded. They are
imported once per new export: Google rotates some of them afterwards, and
re-adding the exported values would undo that.

Two rejections are deliberately kept apart, because confusing them used to
turn one slow page load into a half-hour outage:

  * GoogleBlocked — Google itself refused (CAPTCHA, "unusual traffic", 429).
    Never retried immediately and never solved; this is what pauses the
    shared free-search state.
  * GoogleUnavailable — this worker's side failed (navigation timeout, the
    browser was torn down under us, an unrecognised layout). Retried at once
    on a fresh browser, then left for the next row; it never pauses Google.
"""

from __future__ import annotations

import asyncio
import logging
import random
import re
import time
from pathlib import Path
from urllib.parse import parse_qs, quote_plus, urljoin, urlsplit

import httpx
from bs4 import BeautifulSoup

from .browser import launch_persistent
from .cache import Cache
from .cookies import import_once, load_cookies
from .config import CACHE_DIR
from .search import SEARCH_TTL, Result

log = logging.getLogger(__name__)

PROVIDER = "google-web"
COUNTER = "google-web"
STATE_NS = "search-state"
RESULTS_NS = "search-google"
PANEL_NS = "search-google-panel"
# Checked against the address and the visible text only: every normal results
# page carries "/sorry/index" in its scripts.
BLOCKED_URL = re.compile(r"/sorry/|/recaptcha/", re.I)
BLOCKED_TEXT = re.compile(r"unusual traffic from your computer|detected unusual traffic", re.I)
NO_RESULTS = re.compile(r"did not match any documents|No results found for|"
                        r"It looks like there aren.t many great matches", re.I)
# Google's consent choice, so the EU consent wall doesn't replace the basic
# HTML page. The browser answers the consent page itself instead: a reused
# cookie value makes Google ask for a CAPTCHA.
CONSENT_COOKIE = {"SOCS": "CAESHAgBEhJnd3NfMjAyMzA4MTAtMF9SQzIaAmVuIAEaBgiAo_CmBg"}
HTTP_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")
FIRST_PAUSE = 30 * 60
LONGEST_PAUSE = 8 * 3600
# A block (not a slow load) is the only thing that pauses: 30 min, then 1, 2, 4,
# 8 h. A transient failure is retried once before it is given up on.
MAX_ATTEMPTS = 2
MAX_PAUSE_STEPS = 6
# The only cookie hosts loaded from a cookies.txt export.
SEARCH_COOKIE_HOSTS = {"google.com", "www.google.com"}
IMPORT_STAMP = ".cookies-imported"
SIGNED_IN = 'a[aria-label^="Google Account"], a[href*="accounts.google.com/SignOutOptions"]'

# Google's Business Profile panel: the business's own name, address, phone,
# website and "Profiles" (the social pages it added to its profile).
_PANEL_JS = r"""() => {
  const field = attr => {
    const el = document.querySelector(`[data-attrid="${attr}"]`);
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : '';
  };
  const name = field('title');
  if (!name) return null;
  const website = [...document.querySelectorAll('[data-attrid="kc:/local:unified_actions"] a[href]')]
    .find(a => /website/i.test(a.innerText || a.getAttribute('aria-label') || ''));
  const profiles = [...document.querySelectorAll('[data-attrid="kc:/common/topic:social media presence"] a[href]')]
    .map(a => ({label: (a.innerText || a.getAttribute('aria-label') || '').trim(), href: a.getAttribute('href')}));
  return {name, website: website ? website.getAttribute('href') : '',
          address: field('kc:/location/location:address').replace(/^Address:\s*/i, ''),
          phone: (field('kc:/local:alt phone') || field('kc:/collection/knowledge_panels/has_phone:phone'))
                   .replace(/^Phone:\s*/i, ''),
          category: field('subtitle'), profiles};
}"""

# Each organic result: the link around its <h3>, the text of the block it sits
# in (title, displayed URL and snippet), and the displayed URL.
_RESULTS_JS = """() => {
  const out = [], seen = new Set();
  for (const h3 of document.querySelectorAll('a h3')) {
    const a = h3.closest('a');
    const href = a && a.getAttribute('href');
    if (!href || seen.has(href)) continue;
    seen.add(href);
    let block = a;
    for (let i = 0; i < 8 && block.parentElement; i++) {
      const p = block.parentElement;
      if (p.querySelectorAll('a h3').length > 1) break;
      block = p;
    }
    const cite = block.querySelector('cite');
    out.push({href, title: h3.innerText, text: block.innerText, cite: cite ? cite.innerText : ''});
  }
  return out;
}"""


class GoogleUnavailable(Exception):
    """Google can't answer right now (daily limit, no browser, a bad load).

    Retryable and local to this worker: it never pauses the shared free-search
    state, so the next row tries Google again."""


class GoogleBlocked(GoogleUnavailable):
    """Google itself refused to answer: a CAPTCHA, "unusual traffic" or 429.

    This is the only failure that pauses the shared free-search state, because
    asking again makes a real block last longer."""


class GoogleFreeSearch:
    def __init__(self, cache: Cache, fetcher=None, daily_limit: int = 150,
                 gap: tuple[float, float] = (6.0, 15.0), use_browser: bool = True,
                 profile_dir: Path | None = None, share_fetcher_driver: bool = False,
                 cookies_file: Path | None = None) -> None:
        self.cache = cache
        self.profile_dir = profile_dir or CACHE_DIR / "google-profile"
        self.cookies_file = cookies_file
        self._profile_used: Path | None = None  # each browser has its own folder
        self.signed_in: bool | None = None  # checked on each session's home page
        self._last_panel: dict | None = None
        self.daily_limit = daily_limit
        self.gap = gap
        self.use_browser = use_browser
        # Off by default: the fetcher's browser shutdown stops its whole
        # Playwright driver, which used to kill a search mid-query and stall
        # every later row. Only opt in where the extra driver process matters
        # more than that hazard.
        self.share_fetcher_driver = bool(share_fetcher_driver) and fetcher is not None
        self.fetcher = fetcher if self.share_fetcher_driver else None
        self._lock = asyncio.Lock()
        self._last = 0.0
        self._ctx = None
        self._page = None
        self._channel: str | None = None
        self._pw = None
        self._browser_lock = asyncio.Lock()
        self._last_used = time.monotonic()
        self._client = httpx.AsyncClient(timeout=20.0, follow_redirects=True, headers={
            "User-Agent": HTTP_UA,
            "Accept-Language": "en-US,en;q=0.9",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        }, cookies=CONSENT_COOKIE)

    @property
    def enabled(self) -> bool:
        return self.daily_limit > 0

    def paused_for(self) -> float:
        state = self.cache.get(STATE_NS, "google-pause") or {}
        return max(0.0, float(state.get("until", 0)) - time.time())

    async def business_profile(self, query: str, country: str = "US") -> dict | None:
        """Google's Business Profile panel for this search, if it shows one:
        {name, address, phone, website, category, profiles: {site: url}}.
        Raises like search()."""
        key = f"{country}|{query[:600]}"
        panel = self.cache.get(PANEL_NS, key)
        if panel is None:
            await self.search(query, country, need_panel=True)
            panel = self.cache.get(PANEL_NS, key)
        return panel or None

    async def search(self, query: str, country: str = "US", count: int = 10,
                     need_panel: bool = False) -> list[Result]:
        """Organic results ([] when Google says there are none).

        Raises GoogleBlocked when Google itself refused, or GoogleUnavailable
        for a failure on this side (retryable at once; see the module
        docstring). A transient failure gets one retry on a fresh browser, so a
        single slow page load costs one retry instead of the rest of the day's
        free search.
        """
        query = query[:600]
        key = f"{country}|{query}"
        async with self._lock:
            cached = self.cache.get(RESULTS_NS, key)
            # Results cached before panels were read don't have one: ask again.
            if cached is not None and not (need_panel and self.cache.get(PANEL_NS, key) is None):
                return [Result(**r) for r in cached][:count]
            if self.paused_for():
                raise GoogleBlocked(f"paused, resumes in {int(self.paused_for() / 60) + 1} min")
            # Reserved once per distinct query, before the network: a repeat
            # served from the cache above never spends the day's allowance.
            if not self.cache.reserve(COUNTER, self.daily_limit):
                raise GoogleBlocked("daily free-search limit reached")
            last: Exception | None = None
            for attempt in range(MAX_ATTEMPTS):
                blocked = False
                try:
                    await self._pace()
                    results = await self._via_http(query, country)
                    if results is None:
                        results = await self._via_browser(query, country)
                except GoogleBlocked as err:
                    blocked, last = True, err
                except GoogleUnavailable as err:
                    # A transient failure: start the browser over and ask once
                    # more. Only a real block pauses Google.
                    last = err
                    await self._close_browser()
                else:
                    self.cache.set(STATE_NS, "google-pause", {"until": 0, "step": 0}, 30 * 86400)
                    self.cache.set(RESULTS_NS, key, [r.__dict__ for r in results], SEARCH_TTL)
                    self.cache.set(PANEL_NS, key, self._last_panel or {}, SEARCH_TTL)
                    return results[:count]
                if blocked:
                    break
            if last is None:  # pragma: no cover - the loop always sets it
                last = GoogleUnavailable("free Google search failed")
            if isinstance(last, GoogleBlocked):
                # A fresh session starts over on the home page; the stale
                # cookies of a blocked session are not worth reusing.
                await self._close_browser()
                raise self._pause(str(last)) from last
            raise last

    async def _pace(self) -> None:
        wait = self._last + random.uniform(*self.gap) - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        self._last = time.monotonic()

    def _pause(self, why: str) -> GoogleBlocked:
        state = self.cache.get(STATE_NS, "google-pause") or {}
        step = min(int(state.get("step", 0)) + 1, MAX_PAUSE_STEPS)
        seconds = min(LONGEST_PAUSE, FIRST_PAUSE * 2 ** (step - 1))
        self.cache.set(STATE_NS, "google-pause", {"until": time.time() + seconds, "step": step}, 30 * 86400)
        log.warning("Google free search paused for %d min: %s", seconds // 60, why)
        return GoogleBlocked(f"{why}; paused for {seconds // 60} min")

    # ── pathway 1: plain HTTP ────────────────────────────────────────────────

    async def _via_http(self, query: str, country: str) -> list[Result] | None:
        """Results from Google's basic HTML page, or None if it isn't served."""
        if self.cache.get(STATE_NS, "google-http-off"):
            return None
        try:
            res = await self._client.get("https://www.google.com/search", params={
                "q": query, "hl": "en", "gl": country.lower(), "num": "10", "gbv": "1",
            })
        except httpx.HTTPError:
            return None
        visible = _visible_text(res.text)
        if res.status_code == 429 or BLOCKED_URL.search(str(res.url)) or BLOCKED_TEXT.search(visible):
            raise GoogleBlocked("Google answered with a CAPTCHA")
        results = parse_basic_html(res.text) if res.status_code == 200 else []
        if results or (res.status_code == 200 and NO_RESULTS.search(visible)):
            return results
        # JavaScript wall, consent page or an unknown layout: don't ask again this week.
        self.cache.set(STATE_NS, "google-http-off", True, 7 * 86400)
        log.info("Google's no-JavaScript results page isn't served; using the browser pathway.")
        return None

    # ── pathway 2: a real browser ────────────────────────────────────────────

    async def _via_browser(self, query: str, country: str) -> list[Result]:
        if not self.use_browser:
            raise GoogleUnavailable("browser research is turned off (EMAIL_FINDER_USE_BROWSER=0)")
        if self.share_fetcher_driver:
            # Lend the fetcher's driver for the whole page visit, so its browser
            # shutdown waits rather than tearing this query down mid-load.
            await self.fetcher.hold_driver()
        self._last_panel = None
        try:
            page = await self._tab()
            await self._ask(page, query, country)
            visible = await page.evaluate("document.body ? document.body.innerText : ''")
            if BLOCKED_URL.search(page.url) or BLOCKED_TEXT.search(visible):
                raise GoogleBlocked("Google asked for a CAPTCHA")
            raw = await page.evaluate(_RESULTS_JS)
            if not raw:
                if NO_RESULTS.search(visible):
                    return []
                raise GoogleUnavailable("Google's results page layout wasn't recognised")
            results: list[Result] = []
            for item in raw[:10]:
                link = await self._resolve(page, item.get("href", ""), item.get("cite", ""))
                if not link:
                    continue
                title = _squash(item.get("title", ""))
                snippet = _squash(item.get("text", "")).replace(title, "", 1).strip()
                results.append(Result(url=link, title=title, snippet=snippet[:1500], provider=PROVIDER))
            self._last_panel = await self._read_panel(page)
            return results
        except GoogleUnavailable:
            raise
        except Exception as err:  # noqa: BLE001 - retried once on a fresh browser
            await self._close_browser()
            detail = (str(err).strip().splitlines() or [""])[0][:160]
            raise GoogleUnavailable(f"browser search failed ({type(err).__name__}: {detail})") from err
        finally:
            self._last_used = time.monotonic()
            if self.share_fetcher_driver:
                await self.fetcher.release_driver()

    async def _ask(self, page, query: str, country: str) -> None:
        """Search the way a person does. Each browser session starts on the home
        page (answering the consent dialog), then every query is typed into the
        search box; a new, cookie-less profile that jumps straight to a /search
        address gets a CAPTCHA. The /search address is only the fallback."""
        if not page.url.startswith("https://www.google."):
            await page.goto("https://www.google.com/?hl=en", wait_until="domcontentloaded", timeout=30_000)
            await page.wait_for_timeout(random.randint(1200, 2200))
            await self._check_signed_in(page)
        await self._answer_consent(page)
        before = page.url
        try:
            await page.locator("textarea[name=q], input[name=q]").first.click(timeout=5000)
            await page.keyboard.press("Control+A")
            await page.keyboard.type(query, delay=random.randint(35, 80))
            await page.wait_for_timeout(random.randint(250, 600))
            await page.keyboard.press("Enter")
            await page.wait_for_url(lambda u: u != before and "/search" in u, wait_until="domcontentloaded",
                                    timeout=20_000)
        except Exception:  # noqa: BLE001 - no usable search box
            url = f"https://www.google.com/search?q={quote_plus(query)}&hl=en&gl={country.lower()}"
            await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            if "consent.google" in page.url:
                await self._answer_consent(page)
                await page.goto(url, wait_until="domcontentloaded", timeout=30_000)
        await page.wait_for_timeout(random.randint(1200, 2400))

    async def _read_panel(self, page) -> dict | None:
        """The Business Profile panel, with its profile links resolved."""
        try:
            panel = await page.evaluate(_PANEL_JS)
        except Exception:  # noqa: BLE001 - no panel is not a failed search
            return None
        if not panel:
            return None
        profiles: dict[str, str] = {}
        for item in panel.pop("profiles", [])[:8]:
            link = await self._resolve(page, item.get("href") or "", "")
            host = urlsplit(link or "").netloc.lower().removeprefix("www.").removeprefix("m.")
            site = host.split(".")[-2] if host.count(".") >= 1 else ""
            if link and site and site not in profiles:
                profiles[site] = link
        website = panel.get("website") or ""
        if website.startswith("/"):
            website = await self._resolve(page, website, "") or ""
        panel.update(profiles=profiles, website=website)
        return panel

    async def _check_signed_in(self, page) -> None:
        signed_in = bool(await page.locator(SIGNED_IN).count())
        if signed_in != self.signed_in:
            if signed_in:
                log.info("Google free search is signed in to your Google account")
            elif self.cookies_file:
                log.warning("Google free search isn't signed in: the cookies in %s have expired or were "
                            "signed out. Searching signed out; export cookies.txt again to sign back in.",
                            self.cookies_file.name)
        self.signed_in = signed_in

    async def _import_cookies(self, ctx) -> None:
        """Load the export's google.com cookies into the profile, once per export."""
        profile = self._profile_used or self.profile_dir
        await import_once(ctx, self.cookies_file, SEARCH_COOKIE_HOSTS, profile, IMPORT_STAMP)

    async def _resolve(self, page, href: str, cite: str) -> str | None:
        """The result's real address. Google wraps result links in /url?q= or in
        an opaque /goto?url= token; the token is followed with one redirect-only
        request unless the displayed URL is already complete."""
        target = urljoin("https://www.google.com/", href)
        parts = urlsplit(target)
        host = parts.netloc.lower()
        if not (host == "google.com" or host.endswith(".google.com")):
            return target if parts.scheme in ("http", "https") else None
        if parts.path not in ("/url", "/goto"):
            return None  # Maps, Images and other Google pages
        for name in ("q", "url"):
            value = parse_qs(parts.query).get(name, [""])[0]
            if value.startswith(("http://", "https://")):
                return value
        shown = cite.strip()
        if re.fullmatch(r"https?://[^\s›]+", shown):
            return shown
        try:
            await asyncio.sleep(random.uniform(0.2, 0.6))
            res = await page.request.get(target, max_redirects=0, timeout=10_000)
            location = res.headers.get("location", "")
        except Exception:  # noqa: BLE001
            return None
        return location if location.startswith(("http://", "https://")) else None

    async def _answer_consent(self, page) -> None:
        for label in ("Reject all", "Accept all", "I agree"):
            button = page.get_by_role("button", name=label)
            if await button.count():
                await button.first.click(timeout=5000)
                await page.wait_for_timeout(1500)
                return

    async def _tab(self):
        if self._page is not None and not self._page.is_closed():
            return self._page
        if self._ctx is None:
            await self._launch()
        self._page = self._ctx.pages[0] if self._ctx.pages else await self._ctx.new_page()
        return self._page

    def _forget_driver(self) -> None:
        """Drop a Playwright driver that can no longer be used.

        Playwright exposes no public way to ask whether its driver is still
        running, so a driver that stopped under us is simply discarded; the
        next launch asks the fetcher again, or starts a fresh one.
        """
        pw, self._pw = self._pw, None
        if pw is None or self.share_fetcher_driver:
            return  # the fetcher owns that driver; never stop it from here
        try:
            asyncio.get_running_loop().create_task(pw.stop())
        except RuntimeError:  # no running loop (teardown)
            pass

    async def _launch(self) -> None:
        async with self._browser_lock:
            if self._ctx is not None:
                return  # another row started it while this one waited
            if self._pw is None:
                if self.share_fetcher_driver:
                    self._pw = await self.fetcher._ensure_playwright()
                else:
                    from playwright.async_api import async_playwright
                    self._pw = await async_playwright().start()
            started = time.monotonic()
            try:
                ctx, channel, self._profile_used = await launch_persistent(self._pw, self.profile_dir, locale="en-US")
            except Exception as err:  # noqa: BLE001 - no browser would start
                self._forget_driver()
                raise GoogleUnavailable(f"no browser could be started ({type(err).__name__})") from err
            self._ctx, self._channel = ctx, channel
            self.signed_in = None
            log.info("Google free search uses %s (started in %.0f s)", channel or "Playwright Chromium",
                     time.monotonic() - started)
            try:
                await self._import_cookies(ctx)
            except Exception as err:  # noqa: BLE001 - search signed out rather than not at all
                log.warning("Couldn't load Google cookies (%s); searching signed out", type(err).__name__)

    async def close_idle(self, idle_seconds: float = 300) -> None:
        if self._ctx is not None and time.monotonic() - self._last_used > idle_seconds and not self._lock.locked():
            await self._close_browser()

    async def _close_browser(self) -> None:
        async with self._browser_lock:
            ctx, self._ctx, self._page = self._ctx, None, None
        if ctx is not None:
            try:
                await ctx.close()
            except Exception:  # noqa: BLE001
                pass

    async def close(self) -> None:
        await self._close_browser()
        await self._client.aclose()
        pw, self._pw = self._pw, None
        if pw is not None and not self.share_fetcher_driver:
            try:
                await pw.stop()
            except Exception:  # noqa: BLE001
                pass


def parse_basic_html(html: str) -> list[Result]:
    """Results from Google's no-JavaScript page: /url?q= links (the txt
    file's filter) or plain links around an <h3>."""
    soup = BeautifulSoup(html, "lxml")
    anchors = [a for a in soup.find_all("a", href=True)
               if a["href"].startswith("/url?") or (a.find("h3") and a["href"].startswith("http"))]
    results: list[Result] = []
    seen: set[str] = set()
    for a in anchors:
        href = a["href"]
        if href.startswith("/url?"):
            href = parse_qs(urlsplit(href).query).get("q", [""])[0]
        host = urlsplit(href).netloc.lower()
        if not href.startswith("http") or host.endswith("google.com") or href in seen:
            continue
        seen.add(href)
        block = a
        for _ in range(6):
            parent = block.parent
            if parent is None or len([x for x in parent.find_all("a", href=True) if x in anchors]) > 1:
                break
            block = parent
        title = _squash(a.get_text(" "))
        text = _squash(block.get_text(" "))
        results.append(Result(url=href, title=title, snippet=text.replace(title, "", 1).strip()[:1500],
                              provider=PROVIDER))
    return results[:10]


def load_search_cookies(path: Path) -> list[dict]:
    """The google.com search cookies from a cookies.txt export; every other
    site's cookies (and expired ones) are skipped."""
    return load_cookies(path, SEARCH_COOKIE_HOSTS)


def _visible_text(html: str) -> str:
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    return soup.get_text(" ")


def _squash(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()
