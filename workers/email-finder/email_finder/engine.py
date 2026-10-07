"""Find the best email for one school row: the decision maker's if possible.

Strategy, cheapest first, stopping once a decision maker's address is solid:
  1. The school's website: home, contact, about/team/instructor pages,
     privacy/terms (often carry an address); JavaScript-only pages are
     rendered in headless Chrome.
     - Cloudflare-obfuscated emails are decoded automatically.
     - Math-challenge reveals: if a page gates the email behind "Solve 3+4",
       the engine calculates the answer, types it into the input field, and
       re-reads the page.
  2. Search for the school by name + town: snippets frequently quote the
     email from Google/Facebook/Instagram/directory listings; finds the
     website when the sheet has none (or only a Facebook page).
     When there's nothing to go on (no website, no Facebook/Instagram,
     nothing from a listing), every search runs on free Google first
     (google_free.py, GOOGLE-FREE-SEARCH.txt), plus Google-only queries
     (free-mail addresses, the phone number, owner mentions, the street).
     Brave keys are used only if that finds no address or Google is paused.
  3. Logged-in Facebook and Instagram profile scraping (uses the user's
     own Chrome profile — already signed in).  FB About/Contact Info tab,
     IG bio + Contact button dropdown.
  4. Martial-arts directories, federations and tournament/team listings for
     the school's style and country (email-hunt.txt), read when public.
  5. Last resort: if only a contact form was found, record it.

Every address is checked (syntax + domain mail servers), then scored with
spaCy's view of who it belongs to.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import datetime, timezone, timedelta
from dataclasses import dataclass, field
from urllib.parse import parse_qs, urlsplit

import tldextract
from rapidfuzz import fuzz

from . import nlp
from .nlp import context_score_delta
from .extract import Candidate, PageInfo, _is_profile, contact_like_links, emails_in_text, parse_page
from .fetch import Fetcher, instagram_profile_url
from .google_free import GoogleBlocked, GoogleFreeSearch, GoogleUnavailable
from .search import BraveSearch, Result, SearchBudgetExhausted, SearchUnavailable
from .sources import (
    FEDERATION_SITES_BY_STYLE,
    FEDERATION_SITES_GENERAL,
    FREE_MAIL_DOMAINS,
    LINK_IN_BIO_HOSTS,
    PLATFORM_HOSTS,
    SNIPPET_ONLY_HOSTS,
    SOCIAL_HOSTS,
    NO_EMAIL_HOSTS,
    VENDOR_HOSTS,
    directory_sites,
    host_matches,
)
from .validate import DomainChecker, DnsUnavailable, plausible
from .scoring import ScoreWeights, load_weights

log = logging.getLogger(__name__)
_extract = tldextract.TLDExtract(suffix_list_urls=(), cache_dir=None)
_nlp_lock = asyncio.Lock()

UK_POSTCODE = re.compile(r"\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b", re.I)
US_STATE_ZIP = re.compile(r",?\s*\b([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*$")
GENERIC_TITLE_WORDS = {
    "the", "and", "of", "in", "at", "for", "&", "martial", "arts", "art", "academy", "club", "school",
    "studio", "dojo", "gym", "centre", "center", "karate", "taekwondo", "jiu", "jitsu", "jiujitsu",
    "bjj", "kung", "fu", "mma", "kickboxing", "boxing", "judo", "self", "defense", "defence", "fitness",
    "training", "team", "kids", "family", "llc", "ltd", "inc", "tkd", "muay", "thai", "krav", "maga",
}
LISTING_WORDS = (
    "directory", "dojos", "yell", "chamber", "listing", "local", "map", "find", "near",
    "biz", "business", "places", "guide", "review", "top10", "best", "dotuk", "cylex", "hotfrog",
)
LISTING_PATH = re.compile(r"/(details?|listing|listings|biz|place|places|business|company|companies|profile)/", re.I)
DESIGNER_CONTEXT = re.compile(
    r"(web ?site|web design|designed|developed|built|powered|created|hosted|seo|marketing) by|"
    r"design(s|ed)? by|agency|web ?master",
    re.I,
)
SOURCE_BASE = {"mailto": 40, "app-contact": 40, "jsonld": 38, "cf_decode": 36, "text": 34, "spelled": 34, "snippet": 26, "directory": 24}

# A bare row whose free Google pass couldn't answer (the browser was slow or
# torn down) waits this long and is researched again; Brave is not paid for it.
RETRY_WHEN_GOOGLE_STALLS = 600
# A known profile the phone couldn't read (busy, limited for the day, restarting)
# waits this long instead of being closed as "no address here".
RETRY_WHEN_PHONE_UNAVAILABLE = 1800
# google_free.py's wording when free search is paused after Google refused.
PAUSED = re.compile(r"paused|resumes in", re.I)

# Google Forms host patterns
GOOGLE_FORMS_HOSTS = ("docs.google.com", "forms.gle")

# Selectors and patterns for math-challenge reveal
MATH_INPUT_SELECTORS = [
    "input[name*='answer']",
    "input[name*='captcha']",
    "input[name*='math']",
    "input[name*='sum']",
    "input[placeholder*='answer']",
    "input[type='text']",  # generic fallback
]


@dataclass
class Row:
    title: str
    website: str = ""
    address: str = ""
    phone: str = ""
    category: str = ""
    facebook: str = ""
    instagram: str = ""
    shared_domain_count: int = 1


@dataclass
class Finding:
    email: str | None = None
    email_type: str | None = None  # decision-maker | business | staff
    confidence: int = 0
    source_url: str | None = None
    decision_maker: str | None = None  # "Name (role)"
    contact_form_url: str | None = None
    notes: list[str] = field(default_factory=list)
    searches: int = 0
    retry_after: int | None = None
    research_complete: bool = True
    # How the chosen address was found, in words (shown on the Dial page).
    method: str | None = None
    # Verified details for the sheet's empty cells: websiteUrl, phoneNumber,
    # facebookUrl, instagramUrl, youtubeUrl, twitterUrl, linkedinUrl, tiktokUrl.
    enrichment: dict[str, str] = field(default_factory=dict)

    @property
    def status(self) -> str:
        if self.email:
            return "FOUND"
        return "CONTACT_FORM" if self.contact_form_url else "NOT_FOUND"


@dataclass
class _Scored:
    email: str
    score: int
    kind: str
    url: str
    person: nlp.Person | None = None
    source: Candidate | None = None  # the strongest sighting of the address


class Engine:
    def __init__(self, fetcher: Fetcher, search: BraveSearch, domains: DomainChecker, max_site_pages: int = 8,
                 *, scoring: ScoreWeights | None = None, people_executor=None,
                 google: GoogleFreeSearch | None = None, google_mode: str = "bare", galaxy=None):
        self.fetcher = fetcher
        self.search = search
        # The user's Galaxy A20e (android.Galaxy): the real Meta apps as a backup.
        self.galaxy = galaxy
        # Free Google before Brave: "bare" rows only (default), "all" rows, or "off".
        self.google = google
        self.google_mode = google_mode
        self.domains = domains
        self.max_site_pages = max_site_pages
        self.scoring = scoring if scoring is not None else load_weights()
        self.people_executor = people_executor

    async def find(self, row: Row) -> Finding:
        job = _Job(self, row)
        try:
            return await job.run()
        except Exception as err:  # noqa: BLE001
            log.exception("row failed: %s", row.title)
            return Finding(notes=[f"error: {err}"])


class _Job:
    def __init__(self, engine: Engine, row: Row) -> None:
        self.e = engine
        self.row = row
        self.country = (
            "GB"
            if row.phone.replace(" ", "").startswith("+44") or UK_POSTCODE.search(row.address)
            else "US"
        )
        self.town, self.street = _locality(row.address, self.country)
        self.tokens = _title_tokens(row.title)
        self.phone_digits = re.sub(r"\D", "", row.phone)[-10:]
        self.candidates: list[Candidate] = []
        self.pages: list[PageInfo] = []
        self.snippet_texts: list[str] = []
        self.social: set[str] = {u for u in (row.facebook, row.instagram) if u}
        self.forms: list[str] = []
        self.site_host: str | None = None
        self.site_domain: str | None = None
        self.site_is_schools = False
        self._persons_cache: list[nlp.Person] = []
        self._people_blob: str | None = None
        self.own_domains: set[str] = set()
        if row.website and not host_matches(_host(row.website), SOCIAL_HOSTS | LINK_IN_BIO_HOSTS):
            self.own_domains.add(_registered(_host(row.website)))
        self.finding = Finding()
        # Search engine that led to a site, profile or listing (see _origin_key).
        self.discovered_by: dict[str, str] = {}
        self._free_only = False  # searches go to free Google only (the Google pass)
        self._google_blocked = False
        self._cse_answered = False  # the user's Programmable Search Engine found this school
        self._panel_used = False  # a Google Business Profile matched this row
        self._google_answered = False  # free Google replied (a result or "none")
        self._google_stalled = False  # free Google couldn't answer this row
        self._google_stall_logged = False
        self._scraped: set[str] = set()

    def _sheet_is_bare(self) -> bool:
        """The sheet row itself has nothing to go on: no website of its own and
        no Facebook/Instagram (a link-in-bio page counts as nothing to go on)."""
        if self.row.facebook or self.row.instagram:
            return False
        site = (self.row.website or "").strip()
        return not site or host_matches(_host(site), SOCIAL_HOSTS | LINK_IN_BIO_HOSTS)

    # ── orchestration ─────────────────────────────────────────────────────────

    async def run(self) -> Finding:
        finding = await self._run()
        self._finalize_enrichment()
        return finding

    def _finalize_enrichment(self) -> None:
        """The details reported for the sheet's empty cells, once the row is done."""
        f = self.finding
        # Profiles the school's own website links to.
        if self.site_is_schools and self.site_host:
            for info in self.pages:
                if _host(info.url) == self.site_host:
                    for link in sorted(info.social):
                        column = "facebookUrl" if "facebook.com" in link else "instagramUrl"
                        f.enrichment.setdefault(column, link)
        # Never report what the sheet already has.
        for column, have in (("websiteUrl", self.row.website), ("phoneNumber", self.row.phone),
                             ("facebookUrl", self.row.facebook), ("instagramUrl", self.row.instagram)):
            if have:
                f.enrichment.pop(column, None)

    async def _run(self) -> Finding:
        # The default first step: the school's Google Business Profile, for its
        # own website, phone and social pages, verified against the row.
        if not all((self.row.website, self.row.phone, self.row.facebook, self.row.instagram)):
            await self._google_business_profile()
        site = self.row.website.strip()
        host = _host(site)
        if site and host_matches(host, SOCIAL_HOSTS):
            self.social.add(site)
        elif site and host_matches(host, LINK_IN_BIO_HOSTS):
            await self._crawl_link_page(site)
        elif site and _is_listing(site):
            self.own_domains.discard(_registered(host))
            await self._read_directory_page(site)
        elif site:
            await self._crawl_site(site)

        best = await self._decide()
        if not best and self._panel_used and self.social:
            # The profiles its Business Profile lists, before any paid search.
            await self._scrape_social_profiles()
            best = await self._decide()
        free_route = self._google_first()
        if free_route:
            # One free pass, then: an answer is used, and a failure of ours is
            # deferred rather than paid for. Every query in the row has then been
            # asked of Google before any Brave credit is considered.
            best = await self._google_pass()
            if not best and self.social:
                # Profiles Google turned up are read before paying for a search.
                await self._scrape_social_profiles()
                best = await self._decide()
            if not best and self._google_stalled and not self._google_answered and not self._google_blocked:
                # Free Google never managed to answer (a slow load or a
                # torn-down browser). These rows exist to be served by the free
                # pass, so the row waits for it rather than spending Brave
                # credits here; the next run retries Google first.
                self.finding.research_complete = False
                self.finding.retry_after = RETRY_WHEN_GOOGLE_STALLS
                await self._finish(best)
                return self.finding
        # Anything the free pass answered skips Brave: one address is the goal,
        # and these rows exist to be served before any credit is spent. A bare
        # row whose free pass never got an answer was already deferred above, so
        # reaching here with no answer means Google said "none" or refused.
        if not best and self.e.search.enabled and (
            not free_route or self._google_blocked or self._google_answered
        ):
            try:
                for stage in self._search_stages():
                    if best and best.kind == "decision-maker" and best.score >= 85:
                        break
                    await stage()
                    best = await self._decide()
            except (SearchBudgetExhausted, SearchUnavailable) as err:
                self.finding.research_complete = False
                now = datetime.now(timezone.utc)
                midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=5, microsecond=0)
                self.finding.retry_after = min(86400, max(60, int((midnight - now).total_seconds()))) if isinstance(err, SearchBudgetExhausted) else 7200
                self.finding.notes.append(str(err))
        elif not best and not free_route:
            self.finding.research_complete = False
            self.finding.notes.append("Search not configured; website-only research")

        if not best or best.kind != "decision-maker":
            await self._scrape_social_profiles()
            best = await self._decide()

        await self._finish(best)
        return self.finding

    async def _google_business_profile(self) -> None:
        """The school's own Facebook/Instagram pages from its Google Business
        Profile: Google's panel lists the social pages the school added itself,
        the most accurate source there is. Searched by name, then by name and
        address when the first panel isn't clearly this school; a panel is only
        used when it matches the row's phone or address."""
        google = self.e.google
        if google is None or not google.enabled or self.e.google_mode == "off" or self._google_blocked:
            return
        queries = [self.row.title] + ([f"{self.row.title} {self.row.address}"] if self.row.address else [])
        for query in queries:
            try:
                panel = await google.business_profile(query, country=self.country)
            except GoogleBlocked as err:
                self._google_blocked = True
                log.info("Google Business Profile lookup skipped (%s)", err)
                return
            except GoogleUnavailable as err:
                log.info("Google Business Profile lookup failed (%s)", err)
                return
            if panel and self._panel_matches(panel):
                await self._use_panel(panel)
                return

    def _panel_matches(self, panel: dict) -> bool:
        name_ok = fuzz.token_set_ratio(self.row.title.lower(), (panel.get("name") or "").lower()) >= 85
        phone = re.sub(r"\D", "", panel.get("phone") or "")[-10:]
        phone_ok = bool(self.phone_digits) and len(phone) == 10 and phone == self.phone_digits
        address_ok = _same_address(self.row.address, panel.get("address") or "")
        return (name_ok and (phone_ok or address_ok)) or (phone_ok and address_ok)

    async def _use_panel(self, panel: dict) -> None:
        self._panel_used = True
        enrich = self.finding.enrichment
        if (panel.get("website") or "").startswith("http"):
            enrich.setdefault("websiteUrl", panel["website"])
        if panel.get("phone"):
            enrich.setdefault("phoneNumber", panel["phone"])
        for site, url in (panel.get("profiles") or {}).items():
            column = PROFILE_COLUMNS.get(site)
            if column:
                enrich.setdefault(column, instagram_profile_url(url) if site == "instagram"
                                  else url if "profile.php" in url else url.split("?")[0])
        found = []
        for site, url in (panel.get("profiles") or {}).items():
            if site == "instagram":
                url = instagram_profile_url(url)
            elif site == "facebook" and "profile.php" not in url:
                url = url.split("?")[0]
            else:
                continue
            self.social.add(url)
            self.discovered_by.setdefault(_origin_key(url), "google-business-profile")
            found.append(site)
        website = panel.get("website") or ""
        if website.startswith("http") and not self.site_host and not self.row.website:
            self.discovered_by.setdefault(_origin_key(website), "google-business-profile")
            await self._crawl_site(website)
            found.append("website")
        log.info("Google Business Profile matched %s: %s", self.row.title, ", ".join(found) or "no links")

    def _search_stages(self) -> list:
        stages = [self._search_general, self._search_social, self._search_cse,
                  self._search_directories, self._search_federations]
        # The no-website fallback, when the sheet row has no real site.
        has_real_site = bool(self.row.website) and not self.social
        if not has_real_site or not self.site_host:
            stages.append(self._search_no_website_fallback)
        return stages

    def _google_first(self) -> bool:
        """Free Google before the paid chain.

        In "bare" mode the free pass is for rows the sheet gave us nothing for.
        The old test looked only at what the engine had *already* collected, so a
        bare row stopped qualifying the moment its Google Business Profile
        supplied a website or a social page — exactly the rows that still have no
        address. Google is also what finds those pages in the first place, so a
        bare row now keeps its free pass even then, as long as the business
        profile has not already produced an address candidate. Every other row
        qualifies only when there is still nothing to go on, as before. In "all"
        mode every row gets the free pass. False whenever free Google is off, so
        a row is never left with no search at all.
        """
        google = self.e.google
        if google is None or not google.enabled or self.e.google_mode not in ("bare", "all"):
            return False
        if self.e.google_mode == "all":
            return True
        if not (self.site_host or self.social or self.candidates):
            return True
        # A bare row keeps its free pass even after its business profile turned
        # up a website or a social page, because that is not an address and
        # Google is what surfaced those pages in the first place. An address
        # candidate (from the site crawl or a directory listing) ends it.
        return self._sheet_is_bare() and not self.candidates

    async def _google_pass(self) -> _Scored | None:
        """The Google-only queries, then every usual stage, all on free Google."""
        self._free_only = True
        self._google_answered = False
        self._google_stalled = False
        self._google_stall_logged = False
        best = None
        try:
            for stage in (self._search_google_strategies, *self._search_stages()):
                await stage()
                best = await self._decide()
                if self._google_blocked or (best and best.kind == "decision-maker" and best.score >= 85):
                    break
        finally:
            self._free_only = False
        return best

    # ── website crawling ──────────────────────────────────────────────────────

    async def _crawl_site(self, url: str) -> None:
        if not url.startswith("http"):
            url = "https://" + url
        found_before = len(self.candidates)
        home = await self.e.fetcher.get(url)
        if not home:
            home = await self.e.fetcher.render(url)
        if not home:
            return
        if home.blocked and self.e.fetcher.use_browser:
            # Many bot walls answer plain HTTP with 403 but let a real browser in.
            rendered = await self.e.fetcher.render(url)
            if rendered and not rendered.blocked:
                home = rendered
        if home.blocked:
            self.finding.notes.append(f"Human verification required: {home.final_url}")
            return
        self.site_host = _host(home.final_url)
        self.site_domain = _registered(self.site_host)
        self.own_domains |= {self.site_domain, _registered(_host(url))}
        self.site_is_schools = self.row.shared_domain_count < 3 and (
            self._domain_matches_name(self.site_host) or self._header_names_school(home.html)
        )
        info = self._take(home.final_url, home.html, home.via)
        if len(info.text) < 300 and self.e.fetcher.use_browser:
            rendered = await self.e.fetcher.render(home.final_url)
            if rendered and not rendered.blocked:
                info = self._take(rendered.final_url, rendered.html, rendered.via)

        # Math challenge: try to resolve inline before crawling sub-pages
        if info.challenge and info.math_answer is not None and self.e.fetcher.use_browser:
            await self._resolve_math_challenge(home.final_url, info.math_answer)

        to_visit = contact_like_links(info, self.site_host, self.e.max_site_pages - 1)
        for guess in ("/contact", "/contact-us", "/about", "/about-us"):
            candidate = f"{urlsplit(home.final_url).scheme}://{urlsplit(home.final_url).netloc}{guess}"
            if len(to_visit) < self.e.max_site_pages - 1 and candidate not in to_visit:
                to_visit.append(candidate)
        for link in to_visit:
            page = await self.e.fetcher.get(link)
            if page and page.blocked:
                self.finding.notes.append(f"Human verification required: {page.final_url}")
            elif page:
                sub_info = self._take(page.final_url, page.html, page.via)
                # Resolve math challenges on sub-pages too
                if sub_info.challenge and sub_info.math_answer is not None and self.e.fetcher.use_browser:
                    await self._resolve_math_challenge(page.final_url, sub_info.math_answer)
            if self._has_strong_owner_email():
                break

        # Nothing from this site's plain HTML (other sources don't count): many
        # site builders only put the address on the page with JavaScript, so
        # render the contact page, then the homepage.
        if len(self.candidates) == found_before and self.e.fetcher.use_browser:
            contact = next((l for l in to_visit if re.search(r"contact", l, re.I)), None)
            for target in (contact, home.final_url):
                if not target:
                    continue
                rendered = await self.e.fetcher.render(target)
                if rendered and not rendered.blocked:
                    self._take(rendered.final_url, rendered.html, rendered.via)
                if len(self.candidates) > found_before:
                    break

    async def _crawl_found_site(self, url: str) -> None:
        before_state = (self.site_host, self.site_domain, self.site_is_schools, set(self.own_domains), set(self.social))
        before_pages, before_cands, before_forms = len(self.pages), len(self.candidates), len(self.forms)
        await self._crawl_site(url)
        text = " ".join(p.text for p in self.pages[before_pages:])
        digits = re.sub(r"\D", "", text)
        town = (self.town or "").lower()
        if (self.phone_digits and self.phone_digits in digits) or (town and town in text.lower()):
            return
        del self.pages[before_pages:], self.candidates[before_cands:], self.forms[before_forms:]
        self.site_host, self.site_domain, self.site_is_schools, self.own_domains, self.social = before_state

    async def _crawl_link_page(self, url: str) -> None:
        page = await self.e.fetcher.get(url)
        if not page:
            return
        info = self._take(page.final_url, page.html, page.via)
        for link, _ in info.links:
            h = _host(link)
            if host_matches(h, SOCIAL_HOSTS):
                self.social.add(link)
            elif not self.site_host and not host_matches(h, SNIPPET_ONLY_HOSTS | LINK_IN_BIO_HOSTS):
                await self._crawl_site(link)
                break

    def _take(self, url: str, html: str, via: str = "") -> PageInfo:
        info = parse_page(url, html)
        found_by = self.discovered_by.get(_origin_key(url), "")
        for c in info.candidates:
            c.via = via
            c.found_by = found_by
        self.pages.append(info)
        self.candidates.extend(info.candidates)
        self.social |= info.social
        self.forms.extend(info.forms)
        if info.challenge and info.math_answer is None:
            self.finding.notes.append(f"email hidden behind a challenge at {url} (check by hand)")
        return info

    def _has_strong_owner_email(self) -> bool:
        return any(nlp.classify_local(c.email.split("@")[0]) == "decision" for c in self.candidates)

    # ── math challenge resolver ───────────────────────────────────────────────

    async def _resolve_math_challenge(self, url: str, answer: int) -> None:
        page = await self.e.fetcher.reveal_math(url)
        if page and not page.blocked:
            self._take(page.final_url, page.html, page.via)

    # ── logged-in FB/IG social scraping ───────────────────────────────────────

    async def _scrape_social_profiles(self) -> None:
        """Facebook first, then Instagram in iPhone emulation.

        Instagram is the backup, never a dead end: when Facebook gives no
        address it is always tried (the profile from the sheet or search, else
        the Facebook page's handle on Instagram, used only if that profile
        names the school), and the website and link-in-bio pages the Instagram
        profile lists are read too.
        """
        urls = sorted(self.social)
        # Only real profiles: Meta's own pages (policy.php, privacy, login …) and
        # Facebook's share/reel/dialog paths turn up in search results and in
        # panels, and reading one wastes a page load and can park the phone on a
        # page that has nothing to do with the school.
        facebook = [u for u in urls
                    if host_matches(_host(u), {"facebook.com", "fb.com", "m.facebook.com"})
                    and _is_profile(u)][:3]
        instagram = list(dict.fromkeys(
            u for u in (instagram_profile_url(v) for v in urls
                        if host_matches(_host(v), {"instagram.com"}))
            if _is_profile(u)))[:3]
        for url in facebook:
            if url in self._scraped:
                continue
            self._scraped.add(url)
            page = await self.e.fetcher.fetch_fb_profile(url)
            if page and not page.blocked:
                self._take(page.final_url, page.html, page.via)
            else:
                if page:
                    self.finding.notes.append(f"Social login or human verification required: {url}")
                # Facebook resisted the browser (blocked, paused, out of page loads): the phone.
                await self._galaxy_lookup("facebook", url)

        guessed: set[str] = set()
        if not instagram and not await self._decide():
            for url in facebook:
                handle = _facebook_handle(url)
                if handle:
                    guess = f"https://www.instagram.com/{handle}/"
                    guessed.add(guess)
                    instagram.append(guess)
        links: list[str] = []
        on_phone: list[str] = []  # Instagram profiles for the Galaxy if the browser gets nowhere
        for url in instagram[:3]:
            if url in self._scraped:
                continue
            self._scraped.add(url)
            page = await self.e.fetcher.fetch_ig_profile(url)
            if page and page.blocked:
                self.finding.notes.append(f"Social login or human verification required: {url}")
                on_phone.append(url)
                continue
            if not page:
                on_phone.append(url)
                continue
            if url in guessed and not self._relevant(parse_page(page.final_url, page.html).text):
                log.info("Instagram %s isn't this school; not used", url)
                continue
            on_phone.append(url)
            self.social.add(url)
            info = self._take(page.final_url, page.html, page.via)
            links += [link for link in _profile_links(info) if link not in links]
        if links and not await self._decide():
            await self._follow_profile_links(links)
        # A Facebook page the Instagram profile links to (one round, no further hops).
        for url in sorted(self.social - set(facebook) - self._scraped)[:1]:
            if (host_matches(_host(url), {"facebook.com", "fb.com", "m.facebook.com"})
                    and _is_profile(url) and not await self._decide()):
                self._scraped.add(url)
                page = await self.e.fetcher.fetch_fb_profile(url)
                if page and not page.blocked:
                    self._take(page.final_url, page.html, page.via)
        # Still nothing: the Instagram app on the Galaxy, which has the Contact
        # button Instagram's website lacks.
        for url in on_phone[:2]:
            if await self._decide():
                break
            await self._galaxy_lookup("instagram", url, must_match=url in guessed)

    async def _galaxy_lookup(self, app: str, url: str, must_match: bool = False) -> None:
        """Read a profile in the real app on the user's Galaxy A20e."""
        galaxy = self.e.galaxy
        if galaxy is None:
            return
        if app == "instagram":
            handle = urlsplit(url).path.strip("/").split("/")[0]
            if not re.fullmatch(r"[A-Za-z0-9._]{1,30}", handle):
                return
            found = await galaxy.instagram(handle)
        else:
            found = await galaxy.facebook(url)
        if found.blocked:
            # The phone could not read a profile we know is real. That is not an
            # answer of "no address here": without this the row was written to
            # the sheet as NOT_FOUND and never tried again, even though the phone
            # was merely busy, limited for the day, or mid-restart. A profile app
            # that is genuinely paused (a login wall, a checkpoint) needs the
            # user, so that defers for longer.
            log.info("Galaxy A20e didn't look at %s (%s)", url, found.blocked)
            if not must_match:
                # A guessed handle is the exception: the phone refusing it is
                # useful information and the row carries on.
                self.finding.research_complete = False
                self.finding.retry_after = (_phone_pause_seconds(galaxy, app)
                                            or RETRY_WHEN_PHONE_UNAVAILABLE)
                self.finding.notes.append(f"Galaxy A20e didn't look at {url} ({found.blocked})")
            return
        if found.missing:
            log.info("Instagram says %s doesn't exist (tried twice on the Galaxy A20e)", url)
            return
        if must_match and not self._relevant(found.context):
            log.info("Galaxy A20e: %s isn't this school; not used", url)
            return
        found_by = self.discovered_by.get(_origin_key(url), "")
        for email, where in found.emails.items():
            self.candidates.append(Candidate(
                email, "app-contact" if where == "contact" else "text", url,
                _around(found.context, email, 220) if email in found.context.lower() else found.context[:600],
                via="galaxy", found_by=found_by))
        if found.emails:
            log.info("Galaxy A20e found %d address(es) on %s", len(found.emails), url)
            self.finding.enrichment.setdefault("instagramUrl" if app == "instagram" else "facebookUrl", url)
        if found.phones:
            self.finding.enrichment.setdefault("phoneNumber", found.phones[0])

    async def _follow_profile_links(self, links: list[str]) -> None:
        """The school's website and link-in-bio pages, as its Instagram profile lists them."""
        for link in links[:3]:
            host = _host(link)
            self.discovered_by.setdefault(_origin_key(link), "instagram")
            if host_matches(host, LINK_IN_BIO_HOSTS):
                await self._crawl_link_page(link)
            elif host_matches(host, SOCIAL_HOSTS):
                self.social.add(link)
            elif not self.site_host and not host_matches(host, SNIPPET_ONLY_HOSTS | VENDOR_HOSTS):
                # Listed by the school's own profile: no phone/town proof needed.
                await self._crawl_site(link)
            if await self._decide():
                return

    # ── search ────────────────────────────────────────────────────────────────

    async def _search_general(self) -> None:
        where = self.town or self.street or ""
        results = await self._query(f'"{self.row.title}" {where} email'.strip())
        if not results and where:
            results = await self._query(f"{self.row.title} {where}")
        await self._use_results(results, find_site=not self.site_host)

    async def _search_social(self) -> None:
        where = self.town or ""
        results = await self._query(
            f'"{self.row.title}" {where} (site:facebook.com OR site:instagram.com)'.strip()
        )
        await self._use_results(results, find_site=False)

    async def _search_cse(self) -> None:
        """The user's Programmable Search Engine: the curated directories,
        federations and listings (annotations.xml) in one free query."""
        google = self.e.google
        if self._cse_answered or google is None or not getattr(google, "cse_id", None) or self._google_blocked:
            return
        where = self.town or self.street or ""
        for query in (f'"{self.row.title}" {where}'.strip(), f"{self.row.title} {where}".strip()):
            try:
                results = await google.cse_search(query)
            except GoogleBlocked as err:
                log.info("Programmable Search Engine skipped (%s)", err)
                return
            except GoogleUnavailable as err:
                log.info("Programmable Search Engine failed (%s)", err)
                return
            if any(self._search_identity(r.text + " " + r.url) for r in results):
                # It covers the directory and federation sites: no paid queries for them.
                self._cse_answered = True
                await self._use_results(results, find_site=not self.site_host, read_pages=3)
                return

    async def _search_directories(self) -> None:
        if self._cse_answered and not self._free_only:
            return  # the Programmable Search Engine already covered these sites for free
        # Visit every configured source group instead of permanently truncating to eight domains.
        sites = directory_sites(self.country, self.row.category, self.row.title)
        for offset in range(0, len(sites), 6):
            scope = " OR ".join(f"site:{s}" for s in sites[offset:offset + 6])
            results = await self._query(f'"{self.row.title}" {self.town or ""} ({scope})')
            await self._use_results(results, find_site=not self.site_host, read_pages=3)
            best = await self._decide()
            if best and best.kind == "decision-maker" and best.score >= 85:
                break

    async def _search_federations(self) -> None:
        if self._cse_answered and not self._free_only:
            return
        # Directories already include style federations. Search additional owner/media/event evidence.
        where = self.town or self.street or ""
        for suffix in ('owner head instructor email', 'team contact (site:smoothcomp.com OR site:kihapp.com OR site:usamartialartists.org)'):
            results = await self._query(f'"{self.row.title}" {where} {suffix}')
            await self._use_results(results, find_site=not self.site_host, read_pages=3)

    async def _search_no_website_fallback(self) -> None:
        """Targeted search for schools that have no website or only a Facebook page.

        Handles three cases:
          A. School has a Facebook/Instagram URL but no own website.
          B. School has no website AND no social URL — address-only row.
          C. School URL pointed to a listing or was a social link.

        Query priority (cheapest first):
          1. Facebook profile — mobile-first scrape via fetch_fb_profile
          2. Instagram profile — mobile-first scrape via fetch_ig_profile
          3. Business listings: Yelp, Yell, YP
          4. Martial arts directories: USADOJO, MATA, BMABA
          5. Address-only fallback: combine street + city with school name
        """
        where = self.town or self.street or ""
        title = self.row.title

        # ── social-first queries (FB/IG profile pages scraped after finding URL) ──
        social_queries = [
            f'"{title}" {where} site:facebook.com',
            f'"{title}" {where} site:instagram.com',
        ]
        for q in social_queries:
            results = await self._query(q)
            # Collect any social profile URLs returned and queue them for scraping.
            for r in results:
                h = _host(r.url)
                if host_matches(h, SOCIAL_HOSTS) and _is_profile(r.url):
                    self.social.add(r.url.split("?")[0])
            await self._use_results(results, find_site=False, read_pages=1)
            best = await self._decide()
            if best and best.kind == "decision-maker" and best.score >= 80:
                return

        # ── business listing queries ──────────────────────────────────────────
        listing_q = f'"{title}" {where} (site:yelp.com OR site:yell.com OR site:yellowpages.com)'
        results = await self._query(listing_q)
        await self._use_results(results, find_site=not self.site_host, read_pages=2)
        best = await self._decide()
        if best and best.kind == "decision-maker" and best.score >= 80:
            return

        # ── martial arts directory queries ────────────────────────────────────
        if self.country == "GB":
            dir_q = f'"{title}" {where} (site:yell.com OR site:freeindex.co.uk OR site:bmaba.org.uk OR site:usadojo.com)'
        else:
            dir_q = f'"{title}" {where} (site:usadojo.com OR site:bestmartialartsschools.com OR site:usmaf.org OR site:usamartialartists.org)'
        results = await self._query(dir_q)
        await self._use_results(results, find_site=not self.site_host, read_pages=3)
        best = await self._decide()
        if best and best.kind == "decision-maker" and best.score >= 80:
            return

        # ── address-only fallback: school has only a name + street address ────
        # When title alone gave no results, rebuild queries from the street address
        # components.  This covers rows where the sheet column "websiteUrl" is empty
        # and there is no Facebook/Instagram URL.
        if not self.candidates and self.row.address:
            address_queries = self._address_fallback_queries()
            for q in address_queries:
                results = await self._query(q)
                await self._use_results(results, find_site=not self.site_host, read_pages=2)
                best = await self._decide()
                if best and best.score >= 60:
                    return

    def _address_fallback_queries(self) -> list[str]:
        """Build search queries for a name+address only row (no website, no social)."""
        title = self.row.title
        town = self.town or ""
        street = self.street or ""
        # Extract a short numeric street address prefix (e.g. "1921 W Houston St")
        street_short = re.sub(r",.*", "", street).strip()[:60]

        queries: list[str] = []
        # Combine school name with street address — very specific, highest precision
        if street_short and town:
            queries.append(f'"{title}" "{street_short}" {town}')
        elif street_short:
            queries.append(f'"{title}" "{street_short}"')
        # Broader: name + town across FB/IG/Yelp
        if town:
            queries.append(f'"{title}" {town} (site:facebook.com OR site:instagram.com OR site:yelp.com)')
            queries.append(f'"{title}" {town} martial arts email contact')
        # UK-specific: try postcode area
        if self.country == "GB":
            postcode = UK_POSTCODE.search(self.row.address)
            if postcode:
                area = postcode.group(1)  # e.g. "NN3"
                queries.append(f'"{title}" {area} (site:yell.com OR site:bmaba.org.uk OR site:facebook.com)')
        return queries

    async def _query(self, q: str) -> list[Result]:
        if self._free_only:
            if self._google_blocked or self._google_stalled:
                return []  # Google already said no for this row; don't ask per query
            try:
                results = await self.e.google.search(q, country=self.country)
            except GoogleBlocked as err:
                # Google itself refused (CAPTCHA/429): every later Google query
                # in this row would hit the same wall, so Brave takes over.
                self._google_blocked = True
                log.info("Free Google search unavailable (%s); Brave takes over for this row", err)
                return []
            except GoogleUnavailable as err:
                # Our side failed (a slow load, a torn-down browser), or free
                # search is paused for a while after a block. Either way Google
                # answered nothing, so the rest of this row's queries are not
                # sent to it one wasted call at a time. This is deliberately not
                # _google_blocked: only Google refusing defers the row to Brave.
                self._google_stalled = True
                if not self._google_stall_logged:
                    self._google_stall_logged = True
                    if PAUSED.search(str(err)):
                        log.info("Free Google is paused for this row (%s)", err)
                    else:
                        log.info("Free Google search failed on this query (%s); trying the next one", err)
                return []
            self._google_answered = True
            return results
        self.finding.searches += 1
        return await self.e.search.search(q, country=self.country)

    async def _search_google_strategies(self) -> None:
        """Queries only worth running on free Google (each would cost a Brave
        credit): free-mail addresses next to the name, the phone number on its
        own, owner/instructor mentions and the street address."""
        for q in self._google_queries():
            results = await self._query(q)
            await self._use_results(results, find_site=not self.site_host, read_pages=2)
            best = await self._decide()
            if self._google_blocked or (best and best.kind == "decision-maker" and best.score >= 85):
                return

    def _google_queries(self) -> list[str]:
        title, town = self.row.title, self.town or ""
        queries = [f'"{title}" {town} "@gmail.com" OR "@yahoo.com" OR "@hotmail.com" OR "@outlook.com" OR "@aol.com"']
        phones = _phone_variants(self.phone_digits, self.country)
        if phones:
            queries.append(" OR ".join(f'"{p}"' for p in phones))
        queries.append(f'"{title}" {town} owner OR founder OR "head instructor" OR "chief instructor" OR sensei')
        street = re.sub(r",.*", "", self.street or "").strip()[:60]
        if street and re.search(r"\d", street):
            queries.append(f'"{street}" {town} email')
        return [re.sub(r"\s+", " ", q).strip() for q in queries]

    async def _use_results(self, results: list[Result], find_site: bool, read_pages: int = 2) -> None:
        to_read: list[str] = []
        for r in results:
            host = _host(r.url)
            relevant = self._search_identity(r.text + " " + r.url)
            if not relevant:
                continue
            self.discovered_by.setdefault(_origin_key(r.url), r.provider)
            if not host_matches(host, NO_EMAIL_HOSTS) or _team_page(r.url):
                for c in emails_in_text(r.text, r.url, source="snippet"):
                    c.source = "snippet"
                    c.found_by = r.provider
                    self.candidates.append(c)
            self.snippet_texts.append(r.text)
            if host_matches(host, SOCIAL_HOSTS):
                self.social.add(r.url)
                continue
            if host_matches(host, SNIPPET_ONLY_HOSTS):
                continue
            if find_site and not self.site_host and self._looks_official(r, host):
                await self._crawl_found_site(r.url)
                continue
            if self.site_host and host_matches(host, {self.site_host}):
                continue
            if len(to_read) < read_pages:
                to_read.append(r.url)
        for url in to_read:
            await self._read_directory_page(url)

    async def _read_directory_page(self, url: str) -> None:
        page = await self.e.fetcher.get(url)
        if not page or page.blocked:
            return
        info = parse_page(page.final_url, page.html)
        if not self.site_host:
            for link, anchor in info.links:
                h = _host(link)
                if (
                    anchor
                    and fuzz.token_set_ratio(anchor.lower(), self.row.title.lower()) >= 90
                    and h != _host(page.final_url)
                    and not _is_listing(link)
                    and not host_matches(h, SNIPPET_ONLY_HOSTS | VENDOR_HOSTS | LINK_IN_BIO_HOSTS)
                ):
                    await self._crawl_found_site(link)
                    break
        if host_matches(_host(page.final_url), NO_EMAIL_HOSTS) and not _team_page(page.final_url):
            return
        found_by = self.discovered_by.get(_origin_key(url), "")
        for c in info.candidates:
            if self._relevant(_around(c.context, c.email, 220)) and not _is_listing_email(c.email, page.final_url):
                c.source = "directory"
                c.found_by = found_by
                self.candidates.append(c)

    def _relevant(self, text: str) -> bool:
        low = text.lower()
        if self.phone_digits and self.phone_digits in re.sub(r"\D", "", text):
            return True
        if self.tokens and sum(t in low for t in self.tokens) >= max(1, (len(self.tokens) + 1) // 2):
            return True
        return fuzz.partial_ratio(self.row.title.lower(), low) >= 90

    def _search_identity(self, text: str) -> bool:
        if self.phone_digits and self.phone_digits in re.sub(r"\D", "", text):
            return True
        if not self._relevant(text):
            return False
        low = text.lower()
        postcode = UK_POSTCODE.search(self.row.address)
        if postcode and re.sub(r"\s", "", postcode.group()).lower() in re.sub(r"\s", "", low):
            return True
        if self.town and self.town.lower() in low:
            return True
        if self.site_domain and self.site_domain in low:
            return True
        return not self.row.address and fuzz.token_set_ratio(self.row.title.lower(), low) >= 95

    def _looks_official(self, r: Result, host: str) -> bool:
        if host_matches(host, SNIPPET_ONLY_HOSTS | LINK_IN_BIO_HOSTS | VENDOR_HOSTS) or any(
            d in _registered(host) for d in LISTING_WORDS
        ):
            return False
        if self._domain_matches_name(host):
            return True
        phone_hit = bool(self.phone_digits) and self.phone_digits in re.sub(r"\D", "", r.text)
        return phone_hit and not urlsplit(r.url).path.strip("/")

    def _header_names_school(self, html: str) -> bool:
        head = re.sub(r"<[^>]+>", " ", html[:6000]).lower()
        hits = sum(t in head for t in self.tokens)
        town = (self.town or "").lower()
        return hits >= max(1, (len(self.tokens) + 1) // 2) or bool(town and town in head)

    def _domain_matches_name(self, host: str) -> bool:
        name = re.sub(r"[^a-z0-9]", "", _registered(host).split(".")[0])
        squashed = re.sub(r"[^a-z0-9]", "", self.row.title.lower())
        tokens = [t for t in self.tokens if len(t) >= 4]
        return (len(name) >= 4 and fuzz.partial_ratio(name, squashed) >= 80) or any(t in name for t in tokens)

    # ── scoring ───────────────────────────────────────────────────────────────

    async def _decide(self) -> _Scored | None:
        unique: dict[str, list[Candidate]] = {}
        for c in self.candidates:
            if plausible(c.email):
                unique.setdefault(c.email, []).append(c)
        if not unique:
            return None

        persons = await self._people()
        self._persons_cache = persons
        own_emails = [e for e in unique if _registered(e.split("@")[1]) in self.own_domains]
        scored: list[_Scored] = []
        for email, seen in unique.items():
            s = self._score(email, seen, persons, bool(own_emails))
            if s:
                scored.append(s)
        scored.sort(key=lambda s: -s.score)

        for s in scored:
            if s.score < self.e.scoring.minimum_score:
                break
            try:
                deliverable = await self.e.domains.accepts_mail(s.email.split("@")[1])
            except DnsUnavailable:
                self.finding.retry_after = 1800
                self.finding.research_complete = False
                self.finding.notes.append("Mail-domain DNS lookup pending; no validation assumed")
                continue
            if deliverable:
                return s
        return None

    def _score(self, email: str, seen: list[Candidate], persons: list[nlp.Person], has_own: bool) -> _Scored | None:
        local, domain = email.split("@")
        reg = _registered(domain)
        best_src = max(seen, key=lambda c: SOURCE_BASE.get(c.source, 20))
        score = SOURCE_BASE.get(best_src.source, 20)
        contexts = " ".join(c.context for c in seen)
        offsite = best_src.source in ("snippet", "directory")

        # An address the school put behind its own profile's Contact button is
        # its own, even when its website wasn't read.
        published = any(c.source == "app-contact" for c in seen) and domain not in FREE_MAIL_DOMAINS
        if reg in self.own_domains or published:
            affinity = "own"
            score += self.e.scoring.own_domain_bonus
        elif domain in FREE_MAIL_DOMAINS:
            affinity = "free"
            # A free-mail inbox the school publishes behind its own Contact button is
            # its inbox even when its website shows a domain address too.
            from_contact = any(c.source == "app-contact" for c in seen)
            score += 12 if not has_own or from_contact else self.e.scoring.free_mail_with_own_bonus
            # thegrindbjj54@gmail.com published on thegrindbjj.com: the school's own inbox.
            label = re.sub(r"[^a-z0-9]", "", (self.site_domain or "").split(".")[0])
            if len(label) >= 5 and label in re.sub(r"[^a-z0-9]", "", local) and not offsite:
                score += 10
        else:
            affinity = "foreign"
            if DESIGNER_CONTEXT.search(contexts) and not offsite:
                return None
            if self.site_host and host_matches(self.site_host, PLATFORM_HOSTS):
                score += 5
            elif not self.site_domain and offsite and self._looks_like_school_domain(domain):
                score += 15
            elif self.site_is_schools and not offsite:
                score -= 8
            else:
                score -= 25

        relevant = any(self._relevant(c.context) for c in seen)
        if offsite:
            score += 10 if relevant else -30
        elif relevant:
            score += 5
        elif not self.site_is_schools and best_src.source != "jsonld":
            score -= 25
        if len({c.url for c in seen}) > 1:
            score += 5

        kind_local = nlp.classify_local(local)
        squashed_title = re.sub(r"[^a-z0-9]", "", self.row.title.lower())
        if kind_local in ("personal", "other") and fuzz.partial_ratio(re.sub(r"[^a-z0-9]", "", local), squashed_title) >= 85:
            kind_local = "generic"
        owner = nlp.local_part_owner(local, persons)
        near_role = self._role_near(email, seen, persons)
        named = owner if (owner and owner.weight >= 0.8) else None
        nearby = near_role if (near_role and near_role.weight >= 0.8 and owner is None and kind_local in ("personal", "other")) else None
        if kind_local == "decision" or named or nearby:
            kind = "decision-maker"
            score += self.e.scoring.decision_bonus + int(10 * max(owner.weight if owner else 0, near_role.weight if near_role else 0))
        elif kind_local == "generic":
            kind = "business"
            score += 5
        elif kind_local == "personal" and affinity == "free" and not owner and not near_role:
            kind = "business"
            score += 5
        elif owner and self._only_named_lead(owner):
            kind = "staff"
            score += 8
        elif owner or near_role or kind_local == "personal":
            kind = "staff"
            score += 6
        else:
            kind = "business"

        # ── spaCy context classification boost ────────────────────────────────
        # Apply a score delta based on language surrounding the email address.
        # This is the key anti-confusion layer: "info@" in a "founded by John Smith"
        # paragraph still gets a boost; "owner@" on a generic "contact us" page gets penalised.
        ctx_delta = context_score_delta(contexts)
        score += ctx_delta
        if ctx_delta > 0 and kind == "business":
            kind = "decision-maker"  # context strongly suggests a decision-maker inbox

        place_words = [t for t in self.tokens if len(t) >= 4] + (
            [re.sub(r"[^a-z]", "", self.town.lower())] if self.town else []
        )
        if affinity == "own" and any(w and w in local for w in place_words):
            score += 8
        if self.row.shared_domain_count >= 3 and affinity == "own" and kind == "business":
            town = (self.town or "").lower().replace(" ", "")
            score += 10 if town and town in local else -20

        return _Scored(email=email, score=min(score, 99), kind=kind, url=best_src.url, person=named or nearby,
                       source=best_src)

    def _only_named_lead(self, owner: nlp.Person | None) -> bool:
        if not self.site_is_schools or self.row.shared_domain_count >= 3 or not owner:
            return False
        others = [p for p in self._persons_cache if p.weight >= 0.8 and p.name != owner.name]
        return owner.weight >= 0.35 and not others

    def _role_near(self, email: str, seen: list[Candidate], persons: list[nlp.Person]) -> nlp.Person | None:
        nearest: tuple[int, nlp.Person] | None = None
        for c in seen:
            ctx = c.context.lower()
            pos = ctx.find(email)
            if pos < 0:
                continue
            for person in persons:
                at = ctx.find(person.name.lower())
                distance = abs(at - pos)
                if at >= 0 and distance <= 100 and (nearest is None or distance < nearest[0]):
                    nearest = (distance, person)
        return nearest[1] if nearest else None

    async def _people(self) -> list[nlp.Person]:
        texts = [
            p.text
            for p in self.pages
            if re.search(r"about|team|instructor|coach|staff|owner|founder|meet|story|contact", p.url, re.I)
        ]
        texts += [p.text[:8000] for p in self.pages[:1]]
        texts += self.snippet_texts
        texts += [c.context for c in self.candidates]
        blob = "\n".join(dict.fromkeys(texts))[:60_000]
        if not blob.strip():
            return []
        if blob == self._people_blob:
            return self._persons_cache
        if self.e.people_executor is not None:
            found = await asyncio.get_running_loop().run_in_executor(self.e.people_executor, nlp.people, blob)
        else:
            async with _nlp_lock:
                found = await asyncio.to_thread(nlp.people, blob)
        title_words = set(re.findall(r"[a-z]+", self.row.title.lower()))
        self._people_blob = blob
        self._persons_cache = [p for p in found if not set(p.name.lower().split()) & title_words]
        return self._persons_cache

    def _looks_like_school_domain(self, domain: str) -> bool:
        name = _registered(domain).split(".")[0]
        squashed = re.sub(r"[^a-z0-9]", "", self.row.title.lower())
        return fuzz.partial_ratio(name, squashed) >= 80

    # ── result ────────────────────────────────────────────────────────────────

    async def _finish(self, best: _Scored | None) -> None:
        f = self.finding
        f.notes = list(dict.fromkeys(f.notes))
        persons = await self._people()
        lead = best.person if best else next((p for p in persons if p.weight >= 0.8), None)
        if lead:
            f.decision_maker = f"{lead.name} ({lead.role})"
        if best:
            f.email, f.email_type, f.confidence, f.source_url = best.email, best.kind, best.score, best.url
            if best.source:
                f.method = describe_method(best.source, self.site_host, self.own_domains)
            # Search being down only defers rows with nothing to show; an address
            # from the school's own site is written now (research_complete stays False).
            f.retry_after = None
        if self.forms and not best and f.research_complete:
            f.contact_form_url = _best_form(self.forms)


# ── helpers ────────────────────────────────────────────────────────────────────

AFFILIATION_HOSTS = set(FEDERATION_SITES_GENERAL) | {
    domain for _, domains in FEDERATION_SITES_BY_STYLE for domain in domains
}
SOURCE_WORDS = {
    "mailto": "mailto link",
    "jsonld": "structured data (JSON-LD)",
    "cf_decode": "Cloudflare-protected address (decoded)",
    "spelled": "spelled-out address",
    "text": "page text",
}
VIA_WORDS = {
    "galaxy": " in the app on the Galaxy A20e",
    "iphone": " via iPhone emulation",
    "desktop": " via desktop browser",
    "browser": " (rendered in a browser)",
}
SEARCH_WORDS = {
    "google-business-profile": "the school's Google Business Profile",
    "google-cse": "your Programmable Search Engine",
    "instagram": "the school's Instagram profile",
    "google-web": "free Google search",
    "brave": "Brave search",
    "vertex": "Vertex AI search",
}


def describe_method(c: Candidate, site_host: str | None, own_domains: set[str]) -> str:
    """How an address was found, e.g. "Mailto link in the footer of the school's
    homepage" or "Facebook contact info via iPhone emulation (found via free
    Google search)"."""
    search = SEARCH_WORDS.get(c.found_by, "")
    if c.source == "snippet":
        return f"{search[0].upper()}{search[1:]} snippet from {_host(c.url)}" if search \
            else f"Search result snippet from {_host(c.url)}"
    spot = _describe_spot(c, site_host, own_domains)
    return f"{spot} (found via {search})" if search else spot


def _describe_spot(c: Candidate, site_host: str | None, own_domains: set[str]) -> str:
    host = _host(c.url)
    path = urlsplit(c.url).path.lower()
    via = VIA_WORDS.get(c.via, "")
    if host_matches(host, {"facebook.com", "fb.com", "m.facebook.com"}):
        return f"Facebook {'contact info' if 'about' in path else 'page'}{via}"
    if host_matches(host, {"instagram.com"}):
        return f"Instagram {'Contact button' if c.source == 'app-contact' else 'bio text'}{via}"
    if c.source == "directory":
        kind = "Affiliation listing" if host_matches(host, AFFILIATION_HOSTS) else "Directory listing"
        return f"{kind} on {host}"
    if host_matches(host, LINK_IN_BIO_HOSTS):
        return f"Link-in-bio page on {host}"
    first = path.strip("/").split("/")[0]
    page = f"/{first} page" if first else "homepage"
    own = (site_host and host == site_host) or _registered(host) in own_domains
    owner = "the school's" if own else f"{host}'s"
    spot = f"in the footer of {owner} {page}" if c.where == "footer" else f"on {owner} {page}"
    how = SOURCE_WORDS.get(c.source, c.source)
    return f"{how[0].upper()}{how[1:]} {spot}{via}"


# Google Business Profile "Profiles" -> the sheet's column for them.
PROFILE_COLUMNS = {"facebook": "facebookUrl", "instagram": "instagramUrl", "youtube": "youtubeUrl",
                   "twitter": "twitterUrl", "x": "twitterUrl", "linkedin": "linkedinUrl", "tiktok": "tiktokUrl"}
FACEBOOK_NOT_HANDLES = {"profile.php", "pages", "p", "people", "groups", "share", "sharer.php", "watch",
                        "events", "pg", "home.php", "story.php", "permalink.php", "photo.php", "reel",
                        "policy.php", "privacy", "terms", "legal", "help"}
# Instagram's own pages and Meta's: never a school's website.
META_HOSTS = {"instagram.com", "facebook.com", "fb.com", "fb.me", "threads.net", "threads.com", "meta.com",
              "meta.ai", "whatsapp.com", "apple.com", "play.google.com"}


def _same_address(a: str, b: str) -> bool:
    """Whether two addresses are the same place: same ZIP/postcode and the same
    street number or street name ("2025 Gellert Blvd Ste 203, Daly City, CA
    94015" vs "...CA 94015, United States")."""
    if not a or not b:
        return False
    def code(s: str) -> str:
        uk = UK_POSTCODE.search(s)
        if uk:
            return re.sub(r"\s", "", uk.group()).upper()
        us = re.findall(r"\b(\d{5})(?:-\d{4})?\b", s)
        return us[-1] if us else ""
    def street(s: str) -> tuple[str, str]:
        first = s.split(",")[0].lower()
        number = re.match(r"\s*(\d+[a-z]?)\b", first)
        return (number.group(1) if number else ""), re.sub(r"^\s*\d+[a-z]?\s*", "", first)
    (num_a, name_a), (num_b, name_b) = street(a), street(b)
    same_street = (num_a and num_a == num_b) or fuzz.token_set_ratio(name_a, name_b) >= 85
    code_a, code_b = code(a), code(b)
    if code_a and code_b:
        return code_a == code_b and bool(same_street)
    return bool(num_a and num_a == num_b and fuzz.token_set_ratio(name_a, name_b) >= 85)


def _phone_pause_seconds(galaxy, app: str) -> float | None:
    """Seconds the phone's app is paused for, if it says so.

    A pause is the phone deliberately left alone (a login wall, a checkpoint), so
    a row waiting on it should wait about that long rather than retrying into a
    wall every few minutes.
    """
    try:
        paused = float(galaxy.paused_for(app) or 0)
    except Exception:  # noqa: BLE001 - a stand-in without the method, or a bad state
        return None
    return paused if paused > 0 else None


def _facebook_handle(url: str) -> str | None:
    """The page name in facebook.com/<name>, the likeliest Instagram handle."""
    first = urlsplit(url if "//" in url else "https://" + url).path.strip("/").split("/")[0]
    if first.lower() in FACEBOOK_NOT_HANDLES or not re.fullmatch(r"[A-Za-z0-9._]{3,30}", first):
        return None
    # facebook.com/<digits> is a page ID, not a vanity name, so the same string
    # is not an Instagram handle. Guessing one wastes a profile load and can
    # hand the phone an unrelated account.
    if re.fullmatch(r"[0-9.]+", first):
        return None
    return first.lower()


def _profile_links(info: PageInfo) -> list[str]:
    """Websites an Instagram profile links to. Instagram wraps them in
    l.instagram.com/?u=<address>; its own and Meta's pages are skipped."""
    found: list[str] = []
    for link, _ in info.links:
        host = _host(link)
        if host == "l.instagram.com":
            link = parse_qs(urlsplit(link).query).get("u", [""])[0]
            host = _host(link)
        if not link.startswith(("http://", "https://")) or host_matches(host, META_HOSTS):
            continue
        if link not in found:
            found.append(link)
    return found


def _origin_key(url: str) -> str:
    """What a search result introduced: a site (its host) or, on Facebook and
    Instagram, one profile."""
    host = _host(url).removeprefix("m.")
    if host_matches(host, {"facebook.com", "fb.com", "instagram.com"}):
        first = urlsplit(url if "//" in url else "https://" + url).path.strip("/").split("/")[0]
        return f"{host}/{first.lower()}"
    return host


def _phone_variants(digits: str, country: str) -> list[str]:
    """The ways a 10-digit number is usually written, for an exact-phrase search."""
    if len(digits) != 10:
        return []
    if country == "GB":
        return [f"0{digits}", f"0{digits[:4]} {digits[4:]}"]
    a, b, c = digits[:3], digits[3:6], digits[6:]
    return [f"({a}) {b}-{c}", f"{a}-{b}-{c}", f"{a}.{b}.{c}"]


def _team_page(url: str) -> bool:
    return bool(re.search(r"/(?:clubs?|teams?|academ(?:y|ies)|gyms?|schools?)/", urlsplit(url).path, re.I))


def _is_listing(url: str) -> bool:
    host = _host(url)
    if host_matches(host, VENDOR_HOSTS):
        return True
    return any(w in _registered(host) for w in LISTING_WORDS) or bool(LISTING_PATH.search(urlsplit(url).path))


def _is_listing_email(email: str, page_url: str) -> bool:
    local, domain = email.split("@")
    site = re.sub(r"[^a-z]", "", _registered(_host(page_url)).split(".")[0])
    return _registered(domain) == _registered(_host(page_url)) or (
        len(site) >= 4 and fuzz.partial_ratio(site, re.sub(r"[^a-z]", "", local)) >= 70
    ) or any(w in local for w in ("map", "directory", "listing", "details"))


def _around(text: str, needle: str, width: int) -> str:
    pos = text.lower().find(needle.lower())
    if pos < 0:
        return text[: 2 * width]
    return text[max(0, pos - width) : pos + len(needle) + width]


def _host(url: str) -> str:
    try:
        return urlsplit(url if "//" in url else "https://" + url).netloc.lower().removeprefix("www.")
    except ValueError:
        return ""


def _registered(host: str) -> str:
    ext = _extract(host)
    return f"{ext.domain}.{ext.suffix}" if ext.suffix else ext.domain


def _title_tokens(title: str) -> list[str]:
    words = [w for w in re.findall(r"[a-z0-9']+", title.lower()) if len(w) >= 3]
    distinct = [w for w in words if w not in GENERIC_TITLE_WORDS]
    return distinct or words


def _locality(address: str, country: str) -> tuple[str | None, str | None]:
    parts = [p.strip() for p in address.split(",") if p.strip()]
    if not parts:
        return None, None
    street = next((p for p in parts if re.search(r"\d", p) and re.search(r"[A-Za-z]{3,}", p)), parts[0])
    if country == "GB":
        last = UK_POSTCODE.sub("", parts[-1]).strip()
        town = last or (parts[-2] if len(parts) > 1 else None)
    else:
        if US_STATE_ZIP.search(parts[-1]) and len(parts) >= 2:
            town = parts[-2]
        else:
            town = US_STATE_ZIP.sub("", parts[-1]).strip() or None
    return town, street


def _best_form(forms: list[str]) -> str:
    # Prefer Google Forms
    for f in forms:
        if any(h in f for h in GOOGLE_FORMS_HOSTS):
            return f
    return forms[0]
