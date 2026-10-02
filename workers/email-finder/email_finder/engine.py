"""Find the best email for one school row: the decision maker's if possible.

Strategy, cheapest first, stopping once a decision maker's address is solid:
  1. The school's website: home, contact, about/team/instructor pages,
     privacy/terms (often carry an address); JavaScript-only pages are
     rendered in headless Chrome.
     - Cloudflare-obfuscated emails are decoded automatically.
     - Math-challenge reveals: if a page gates the email behind "Solve 3+4",
       the engine calculates the answer, types it into the input field, and
       re-reads the page.
  2. Search (Brave → BEAVE fallback) for the school by name + town:
     snippets frequently quote the email from Google/Facebook/Instagram/
     directory listings; finds the website when the sheet has none (or only
     a Facebook page).
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
from urllib.parse import urlsplit

import tldextract
from rapidfuzz import fuzz

from . import nlp
from .nlp import context_score_delta
from .extract import Candidate, PageInfo, contact_like_links, emails_in_text, parse_page
from .fetch import Fetcher
from .search import BraveSearch, Result, SearchBudgetExhausted, SearchUnavailable
from .sources import (
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
SOURCE_BASE = {"mailto": 40, "jsonld": 38, "cf_decode": 36, "text": 34, "spelled": 34, "snippet": 26, "directory": 24}

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


class Engine:
    def __init__(self, fetcher: Fetcher, search: BraveSearch, domains: DomainChecker, max_site_pages: int = 8,
                 *, scoring: ScoreWeights | None = None, people_executor=None):
        self.fetcher = fetcher
        self.search = search
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

    # ── orchestration ─────────────────────────────────────────────────────────

    async def run(self) -> Finding:
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
        if self.e.search.enabled:
            try:
                # Core search stages, cheapest first
                stages = [
                    self._search_general,
                    self._search_social,
                    self._search_directories,
                    self._search_federations,
                ]
                # Add the no-website fallback when the sheet row has no real site
                has_real_site = bool(self.row.website) and not self.social
                if not has_real_site or not self.site_host:
                    stages.append(self._search_no_website_fallback)

                for stage in stages:
                    if best and best.kind == "decision-maker" and best.score >= 85:
                        break
                    await stage()
                    best = await self._decide()
            except (SearchBudgetExhausted, SearchUnavailable) as err:
                self.finding.research_complete = False
                now = datetime.now(timezone.utc)
                midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=5, microsecond=0)
                self.finding.retry_after = min(86400, max(60, int((midnight - now).total_seconds()))) if isinstance(err, SearchBudgetExhausted) else 1800
                self.finding.notes.append(str(err))
        elif not best or best.kind != "decision-maker":
            self.finding.research_complete = False
            self.finding.notes.append("Search not configured; website-only research")

        if not best or best.kind != "decision-maker":
            await self._scrape_social_profiles()
            best = await self._decide()

        await self._finish(best)
        return self.finding

    # ── website crawling ──────────────────────────────────────────────────────

    async def _crawl_site(self, url: str) -> None:
        if not url.startswith("http"):
            url = "https://" + url
        home = await self.e.fetcher.get(url)
        if not home:
            home = await self.e.fetcher.render(url)
        if not home:
            return
        if home.blocked:
            self.finding.notes.append(f"Human verification required: {home.final_url}")
            return
        self.site_host = _host(home.final_url)
        self.site_domain = _registered(self.site_host)
        self.own_domains |= {self.site_domain, _registered(_host(url))}
        self.site_is_schools = self.row.shared_domain_count < 3 and (
            self._domain_matches_name(self.site_host) or self._header_names_school(home.html)
        )
        info = self._take(home.final_url, home.html)
        if len(info.text) < 300 and self.e.fetcher.use_browser:
            rendered = await self.e.fetcher.render(home.final_url)
            if rendered and not rendered.blocked:
                info = self._take(rendered.final_url, rendered.html)

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
                sub_info = self._take(page.final_url, page.html)
                # Resolve math challenges on sub-pages too
                if sub_info.challenge and sub_info.math_answer is not None and self.e.fetcher.use_browser:
                    await self._resolve_math_challenge(page.final_url, sub_info.math_answer)
            if self._has_strong_owner_email():
                break

        if not self.candidates and self.e.fetcher.use_browser:
            contact = next((l for l in to_visit if re.search(r"contact", l, re.I)), None)
            if contact:
                rendered = await self.e.fetcher.render(contact)
                if rendered and not rendered.blocked:
                    self._take(rendered.final_url, rendered.html)

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
        info = self._take(page.final_url, page.html)
        for link, _ in info.links:
            h = _host(link)
            if host_matches(h, SOCIAL_HOSTS):
                self.social.add(link)
            elif not self.site_host and not host_matches(h, SNIPPET_ONLY_HOSTS | LINK_IN_BIO_HOSTS):
                await self._crawl_site(link)
                break

    def _take(self, url: str, html: str) -> PageInfo:
        info = parse_page(url, html)
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
            self._take(page.final_url, page.html)

    # ── logged-in FB/IG social scraping ───────────────────────────────────────

    async def _scrape_social_profiles(self) -> None:
        """Fetch FB/IG profile pages with the logged-in Chrome context."""
        for social_url in sorted(self.social)[:6]:
            host = _host(social_url)
            if host_matches(host, {"facebook.com", "fb.com", "m.facebook.com"}):
                page = await self.e.fetcher.fetch_fb_profile(social_url)
                if page and not page.blocked:
                    self._take(page.final_url, page.html)
                elif page and page.blocked:
                    self.finding.notes.append(f"Social login or human verification required: {social_url}")
                    log.info("Scraped FB profile: %s", social_url)
            elif host_matches(host, {"instagram.com"}):
                page = await self.e.fetcher.fetch_ig_profile(social_url)
                if page and not page.blocked:
                    self._take(page.final_url, page.html)
                elif page and page.blocked:
                    self.finding.notes.append(f"Social login or human verification required: {social_url}")
                    log.info("Scraped IG profile: %s", social_url)

        # Also search snippets for any FB/IG profiles not in the sheet
        if not self.social and self.e.search.enabled:
            pass  # covered by _search_social()

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

    async def _search_directories(self) -> None:
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
        self.finding.searches += 1
        return await self.e.search.search(q, country=self.country)

    async def _use_results(self, results: list[Result], find_site: bool, read_pages: int = 2) -> None:
        to_read: list[str] = []
        for r in results:
            host = _host(r.url)
            relevant = self._search_identity(r.text + " " + r.url)
            if not relevant:
                continue
            if not host_matches(host, NO_EMAIL_HOSTS) or _team_page(r.url):
                for c in emails_in_text(r.text, r.url, source="snippet"):
                    c.source = "snippet"
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
        for c in info.candidates:
            if self._relevant(_around(c.context, c.email, 220)) and not _is_listing_email(c.email, page.final_url):
                c.source = "directory"
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

        if reg in self.own_domains:
            affinity = "own"
            score += self.e.scoring.own_domain_bonus
        elif domain in FREE_MAIL_DOMAINS:
            affinity = "free"
            score += 12 if not has_own else self.e.scoring.free_mail_with_own_bonus
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

        return _Scored(email=email, score=min(score, 99), kind=kind, url=best_src.url, person=named or nearby)

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
        if self.forms and not best and f.research_complete:
            f.contact_form_url = _best_form(self.forms)


# ── helpers ────────────────────────────────────────────────────────────────────

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
