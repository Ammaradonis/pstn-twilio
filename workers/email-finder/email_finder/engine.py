"""Find the best email for one school row: the decision maker's if possible.

Strategy, cheapest first, stopping once a decision maker's address is solid:
  1. The school's website: home, contact, about/team/instructor pages,
     privacy/terms (often carry an address); JavaScript-only pages are
     rendered in headless Chrome.
  2. Search (Brave) for the school by name + town: snippets frequently quote
     the email from Google/Facebook/Instagram/directory listings; finds the
     website when the sheet has none (or only a Facebook page).
  3. Public Facebook/Instagram profile snippets.
  4. Martial-arts directories, federations and tournament/team listings for
     the school's style and country (email-hunt.txt), read when public.
Every address is checked (syntax + domain mail servers), then scored with
spaCy's view of who it belongs to.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import tldextract
from rapidfuzz import fuzz

from . import nlp
from .extract import Candidate, PageInfo, contact_like_links, emails_in_text, parse_page
from .fetch import Fetcher
from .search import BraveSearch, Result, SearchBudgetExhausted
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
from .validate import DomainChecker, plausible

log = logging.getLogger(__name__)
_extract = tldextract.TLDExtract(suffix_list_urls=(), cache_dir=None)  # bundled list, no network

UK_POSTCODE = re.compile(r"\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b", re.I)
US_STATE_ZIP = re.compile(r",?\s*\b([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*$")
GENERIC_TITLE_WORDS = {
    "the", "and", "of", "in", "at", "for", "&", "martial", "arts", "art", "academy", "club", "school",
    "studio", "dojo", "gym", "centre", "center", "karate", "taekwondo", "jiu", "jitsu", "jiujitsu",
    "bjj", "kung", "fu", "mma", "kickboxing", "boxing", "judo", "self", "defense", "defence", "fitness",
    "training", "team", "kids", "family", "llc", "ltd", "inc", "tkd", "muay", "thai", "krav", "maga",
}
LISTING_WORDS = ("directory", "dojos", "yell", "chamber", "listing", "local", "map", "find", "near",
                 "biz", "business", "places", "guide", "review", "top10", "best", "dotuk", "cylex", "hotfrog")
LISTING_PATH = re.compile(r"/(details?|listing|listings|biz|place|places|business|company|companies|profile)/", re.I)
DESIGNER_CONTEXT = re.compile(
    r"(web ?site|web design|designed|developed|built|powered|created|hosted|seo|marketing) by|"
    r"design(s|ed)? by|agency|web ?master", re.I,
)
SOURCE_BASE = {"mailto": 40, "jsonld": 38, "text": 34, "spelled": 34, "snippet": 26, "directory": 24}
_nlp_lock = asyncio.Lock()


@dataclass
class Row:
    title: str
    website: str = ""
    address: str = ""
    phone: str = ""
    category: str = ""
    facebook: str = ""
    instagram: str = ""
    # How many rows of the same sheet share this website's domain (franchises).
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


class Engine:
    def __init__(self, fetcher: Fetcher, search: BraveSearch, domains: DomainChecker, max_site_pages: int = 8):
        self.fetcher = fetcher
        self.search = search
        self.domains = domains
        self.max_site_pages = max_site_pages

    async def find(self, row: Row) -> Finding:
        job = _Job(self, row)
        try:
            return await job.run()
        except Exception as err:  # noqa: BLE001 - one bad row must not stop the sheet
            log.exception("row failed: %s", row.title)
            return Finding(notes=[f"error: {err}"])


class _Job:
    def __init__(self, engine: Engine, row: Row) -> None:
        self.e = engine
        self.row = row
        self.country = "GB" if row.phone.replace(" ", "").startswith("+44") or UK_POSTCODE.search(row.address) else "US"
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
        # Domains that are the school's own: the sheet's website and wherever it redirects.
        self.own_domains: set[str] = set()
        if row.website and not host_matches(_host(row.website), SOCIAL_HOSTS | LINK_IN_BIO_HOSTS):
            self.own_domains.add(_registered(_host(row.website)))
        self.finding = Finding()

    # ── orchestration ────────────────────────────────────────────────────────

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
                if not best or best.kind != "decision-maker" or best.score < 75:
                    await self._search_general()
                    best = await self._decide()
                if not best:
                    await self._search_social()
                    best = await self._decide()
                if not best:
                    await self._search_directories()
                    best = await self._decide()
            except SearchBudgetExhausted:
                self.finding.notes.append("daily search limit reached; rerun later for more")
        elif not best:
            self.finding.notes.append("search disabled (no BRAVE_API_KEY)")

        await self._finish(best)
        return self.finding

    # ── website crawling ─────────────────────────────────────────────────────

    async def _crawl_site(self, url: str) -> None:
        if not url.startswith("http"):
            url = "https://" + url
        home = await self.e.fetcher.get(url)
        if not home:
            return
        self.site_host = _host(home.final_url)
        self.site_domain = _registered(self.site_host)
        self.own_domains |= {self.site_domain, _registered(_host(url))}
        # A shared site (church, leisure centre, franchise HQ) isn't the
        # school's own: its addresses only count when they mention the school.
        self.site_is_schools = self.row.shared_domain_count < 3 and (
            self._domain_matches_name(self.site_host) or self._header_names_school(home.html)
        )
        info = self._take(home.final_url, home.html)
        if len(info.text) < 300 and self.e.fetcher.use_browser:  # JavaScript-built site
            rendered = await self.e.fetcher.render(home.final_url)
            if rendered:
                info = self._take(rendered.final_url, rendered.html)

        to_visit = contact_like_links(info, self.site_host, self.e.max_site_pages - 1)
        for guess in ("/contact", "/contact-us", "/about", "/about-us"):
            candidate = f"{urlsplit(home.final_url).scheme}://{urlsplit(home.final_url).netloc}{guess}"
            if len(to_visit) < self.e.max_site_pages - 1 and candidate not in to_visit:
                to_visit.append(candidate)
        for link in to_visit:
            page = await self.e.fetcher.get(link)
            if page:
                self._take(page.final_url, page.html)
            if self._has_strong_owner_email():
                break

        if not self.candidates and self.e.fetcher.use_browser:
            # Nothing in the HTML: the contact page may build its email with JavaScript.
            contact = next((l for l in to_visit if re.search(r"contact", l, re.I)), None)
            if contact:
                rendered = await self.e.fetcher.render(contact)
                if rendered:
                    self._take(rendered.final_url, rendered.html)

    async def _crawl_found_site(self, url: str) -> None:
        """Crawl a site found by search; keep it only if it shows this school's
        phone number or town (same-name schools exist in other places)."""
        before_pages, before_cands, before_forms = len(self.pages), len(self.candidates), len(self.forms)
        await self._crawl_site(url)
        text = " ".join(p.text for p in self.pages[before_pages:])
        digits = re.sub(r"\D", "", text)
        town = (self.town or "").lower()
        if (self.phone_digits and self.phone_digits in digits) or (town and town in text.lower()):
            return
        del self.pages[before_pages:], self.candidates[before_cands:], self.forms[before_forms:]
        self.site_host = self.site_domain = None
        self.site_is_schools = False
        self.own_domains.discard(_registered(_host(url)))

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
        if info.challenge:
            self.finding.notes.append(f"email hidden behind a challenge at {url} (check by hand)")
        return info

    def _has_strong_owner_email(self) -> bool:
        return any(nlp.classify_local(c.email.split("@")[0]) == "decision" for c in self.candidates)

    # ── search ───────────────────────────────────────────────────────────────

    async def _search_general(self) -> None:
        where = self.town or self.street or ""
        results = await self._query(f'"{self.row.title}" {where} email'.strip())
        if not results and where:
            results = await self._query(f"{self.row.title} {where}")
        await self._use_results(results, find_site=not self.site_host)

    async def _search_social(self) -> None:
        where = self.town or ""
        results = await self._query(f'"{self.row.title}" {where} (site:facebook.com OR site:instagram.com)'.strip())
        await self._use_results(results, find_site=False)

    async def _search_directories(self) -> None:
        sites = directory_sites(self.country, self.row.category, self.row.title)[:8]
        scope = " OR ".join(f"site:{s}" for s in sites)
        results = await self._query(f'"{self.row.title}" ({scope})')
        await self._use_results(results, find_site=False, read_pages=3)

    async def _query(self, q: str) -> list[Result]:
        self.finding.searches += 1
        return await self.e.search.search(q, country=self.country)

    async def _use_results(self, results: list[Result], find_site: bool, read_pages: int = 2) -> None:
        to_read: list[str] = []
        for r in results:
            host = _host(r.url)
            relevant = self._relevant(r.text + " " + r.url)
            if not relevant:
                continue
            if not host_matches(host, NO_EMAIL_HOSTS):
                for c in emails_in_text(r.text, r.url, source="snippet"):
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
        if not page:
            return
        info = parse_page(page.final_url, page.html)
        if not self.site_host:
            # The listing may link the school's current website (the sheet's
            # can be missing, dead or itself a listing): follow the link named like it.
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
        if host_matches(_host(page.final_url), NO_EMAIL_HOSTS):
            return
        # A directory page lists many schools: keep only emails right next to
        # this school's entry (the site's own address sits elsewhere).
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

    def _looks_official(self, r: Result, host: str) -> bool:
        """A search result is the school's own site only if its domain carries
        the school's name, or it shows the school's phone and isn't a
        marketplace/vendor/directory."""
        if host_matches(host, SNIPPET_ONLY_HOSTS | LINK_IN_BIO_HOSTS | VENDOR_HOSTS) or any(
            d in _registered(host) for d in LISTING_WORDS
        ):
            return False
        if self._domain_matches_name(host):
            return True
        phone_hit = bool(self.phone_digits) and self.phone_digits in re.sub(r"\D", "", r.text)
        # A phone match only proves ownership on a homepage, not a listing's detail page.
        return phone_hit and not urlsplit(r.url).path.strip("/")

    def _header_names_school(self, html: str) -> bool:
        """The page title / top of the page names this school or its town."""
        head = re.sub(r"<[^>]+>", " ", html[:6000]).lower()
        hits = sum(t in head for t in self.tokens)
        town = (self.town or "").lower()
        return hits >= max(1, (len(self.tokens) + 1) // 2) or bool(town and town in head)

    def _domain_matches_name(self, host: str) -> bool:
        name = re.sub(r"[^a-z0-9]", "", _registered(host).split(".")[0])
        squashed = re.sub(r"[^a-z0-9]", "", self.row.title.lower())
        tokens = [t for t in self.tokens if len(t) >= 4]
        return (len(name) >= 4 and fuzz.partial_ratio(name, squashed) >= 80) or any(t in name for t in tokens)

    # ── scoring ──────────────────────────────────────────────────────────────

    async def _decide(self) -> _Scored | None:
        unique: dict[str, list[Candidate]] = {}
        for c in self.candidates:
            if plausible(c.email):
                unique.setdefault(c.email, []).append(c)
        if not unique:
            return None

        persons = await self._people()
        self._persons_cache = persons
        own_names = {d.split(".")[0] for d in self.own_domains}
        own_emails = [e for e in unique if _registered(e.split("@")[1]).split(".")[0] in own_names]
        scored: list[_Scored] = []
        for email, seen in unique.items():
            s = self._score(email, seen, persons, bool(own_emails))
            if s:
                scored.append(s)
        scored.sort(key=lambda s: -s.score)

        for s in scored:
            if s.score < 50:
                break
            if await self.e.domains.accepts_mail(s.email.split("@")[1]):
                # Prefer a decision maker's address when it is nearly as solid.
                dm = next((d for d in scored if d.kind == "decision-maker" and d.score >= max(55, s.score - 15)), None)
                if dm and dm is not s and await self.e.domains.accepts_mail(dm.email.split("@")[1]):
                    return dm
                return s
        return None

    def _score(self, email: str, seen: list[Candidate], persons: list[nlp.Person], has_own: bool) -> _Scored | None:
        local, domain = email.split("@")
        reg = _registered(domain)
        best_src = max(seen, key=lambda c: SOURCE_BASE.get(c.source, 20))
        score = SOURCE_BASE.get(best_src.source, 20)
        contexts = " ".join(c.context for c in seen)
        offsite = best_src.source in ("snippet", "directory")

        if reg in self.own_domains or reg.split(".")[0] in {d.split(".")[0] for d in self.own_domains}:
            affinity = "own"
            score += 25
        elif domain in FREE_MAIL_DOMAINS:
            affinity = "free"
            score += 12 if not has_own else 4
        else:
            affinity = "foreign"
            if DESIGNER_CONTEXT.search(contexts) and not offsite:
                return None  # the web designer's credit, not the school
            if self.site_host and host_matches(self.site_host, PLATFORM_HOSTS):
                score += 5
            elif not self.site_domain and offsite and self._looks_like_school_domain(domain):
                score += 15  # found via search; the school's own domain we hadn't seen
            elif self.site_is_schools and not offsite:
                score -= 8  # listed on the school's own site, e.g. a club leader's ISP address
            else:
                score -= 25

        relevant = any(self._relevant(c.context) for c in seen)
        if offsite:
            score += 10 if relevant else -30
        elif relevant:
            score += 5
        elif not self.site_is_schools and best_src.source != "jsonld":
            score -= 25  # an address on a shared site that never mentions the school
        if len({c.url for c in seen}) > 1:
            score += 5

        kind_local = nlp.classify_local(local)
        squashed_title = re.sub(r"[^a-z0-9]", "", self.row.title.lower())
        if kind_local in ("personal", "other") and fuzz.partial_ratio(re.sub(r"[^a-z0-9]", "", local), squashed_title) >= 85:
            kind_local = "generic"  # gracie.calallen@ / legacymartialartscove@: the school's own inbox
        owner = nlp.local_part_owner(local, persons)
        near_role = self._role_near(email, seen, persons)
        named = owner if (owner and owner.weight >= 0.8) else None
        nearby = near_role if (near_role and near_role.weight >= 0.8 and kind_local in ("personal", "other")) else None
        if kind_local == "decision" or named or nearby:
            kind = "decision-maker"
            score += 25 + int(10 * max(owner.weight if owner else 0, near_role.weight if near_role else 0))
        elif kind_local == "generic":
            kind = "business"
            score += 5
        elif kind_local == "personal" and affinity == "free" and not has_own and self.row.shared_domain_count < 3:
            # A small school that lists a personal Gmail/Yahoo/etc. as its only
            # address: almost always the owner's own inbox.
            kind = "decision-maker"
            score += 15
        elif (owner or kind_local == "personal") and self._only_named_lead(owner):
            # A small club whose only named person is its instructor: they run it.
            kind = "decision-maker"
            score += 15
        elif owner or near_role or kind_local == "personal":
            kind = "staff"
            score += 6
        else:
            kind = "business"

        place_words = [t for t in self.tokens if len(t) >= 4] + ([re.sub(r"[^a-z]", "", self.town.lower())] if self.town else [])
        if affinity == "own" and any(w and w in local for w in place_words):
            score += 8  # this branch's own inbox
        if self.row.shared_domain_count >= 3 and affinity == "own" and kind == "business":
            # Franchise/HQ inbox shared by many locations; prefer a local one.
            town = (self.town or "").lower().replace(" ", "")
            score += 10 if town and town in local else -20

        return _Scored(email=email, score=min(score, 99), kind=kind, url=best_src.url)

    def _only_named_lead(self, owner: nlp.Person | None) -> bool:
        if not self.site_is_schools or self.row.shared_domain_count >= 3 or not owner:
            return False
        others = [p for p in self._persons_cache if p.weight >= 0.8 and p.name != owner.name]
        return owner.weight >= 0.35 and not others

    def _role_near(self, email: str, seen: list[Candidate], persons: list[nlp.Person]) -> nlp.Person | None:
        best: nlp.Person | None = None
        for c in seen:
            ctx = c.context.lower()
            pos = ctx.find(email)
            window = ctx[max(0, pos - 160) : pos + len(email) + 160] if pos >= 0 else ctx[:320]
            for p in persons:
                if p.weight and p.name.lower() in window and (best is None or p.weight > best.weight):
                    best = p
        return best

    async def _people(self) -> list[nlp.Person]:
        texts = [p.text for p in self.pages if re.search(r"about|team|instructor|coach|staff|owner|founder|meet|story|contact", p.url, re.I)]
        texts += [p.text[:8000] for p in self.pages[:1]]
        texts += self.snippet_texts
        blob = "\n".join(dict.fromkeys(texts))[:60_000]
        if not blob.strip():
            return []
        async with _nlp_lock:
            found = await asyncio.to_thread(nlp.people, blob)
        title_words = set(re.findall(r"[a-z]+", self.row.title.lower()))
        return [p for p in found if not set(p.name.lower().split()) & title_words]

    def _looks_like_school_domain(self, domain: str) -> bool:
        name = _registered(domain).split(".")[0]
        squashed = re.sub(r"[^a-z0-9]", "", self.row.title.lower())
        return fuzz.partial_ratio(name, squashed) >= 80

    # ── result ───────────────────────────────────────────────────────────────

    async def _finish(self, best: _Scored | None) -> None:
        f = self.finding
        persons = await self._people()
        lead = next((p for p in persons if p.weight >= 0.8), None)
        if lead:
            f.decision_maker = f"{lead.name} ({lead.role})"
        if best:
            f.email, f.email_type, f.confidence, f.source_url = best.email, best.kind, best.score, best.url
        if self.forms:
            f.contact_form_url = _best_form(self.forms)


# ── helpers ───────────────────────────────────────────────────────────────────


def _is_listing(url: str) -> bool:
    host = _host(url)
    if host_matches(host, VENDOR_HOSTS):
        return True
    return any(w in _registered(host) for w in LISTING_WORDS) or bool(LISTING_PATH.search(urlsplit(url).path))


def _is_listing_email(email: str, page_url: str) -> bool:
    """The directory's own inbox (mapdetailscom@, info@thedirectory.com)."""
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
    for f in forms:
        if "docs.google.com/forms" in f or "forms.gle" in f:
            return f
    return forms[0]
