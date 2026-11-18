"""Instagram profiles whose bio link starts with jointherealworld.com/ or university.com/.

    python scripts/ig_bio_links.py run                # until today's budget is spent
    python scripts/ig_bio_links.py run --limit 40     # at most 40 profiles this run
    python scripts/ig_bio_links.py run --loop         # keep going, day after day
    python scripts/ig_bio_links.py add handle1 handle2   # candidates from elsewhere
    python scripts/ig_bio_links.py resolve            # follow non-matching bio links (no phone)
    python scripts/ig_bio_links.py upload             # push matches to the sheet
    python scripts/ig_bio_links.py report             # what has been found so far

Instagram has no search by bio link and no list of its accounts, so this cannot
walk "every profile". It works from candidates: the IG app's search (seed terms,
then the keyword suggestions they produce) and the suggested accounts on each
match. Every candidate is opened once in the app on the Galaxy A20e, signed in as
the user, and only the link shown on the profile decides a match.

Only reads: it never follows, likes or messages. It shares the worker's phone
lock and pauses, and stops at any challenge or "try again later" screen, which
the user clears by hand. It keeps its own daily budget, so a run doesn't use up
the email finder's lookups, but both run on the same Instagram account.

Links that don't match directly (bit.ly, beacons.ai and the like) are followed
from the PC. Those accounts go on a separate "Suspected TRW" tab:
  Confirmed   the link redirects to a target, or its page links to one
  Suspected   no such link was seen, but the page, handle, name or bio points to TRW
  Unresolved  a shortener or link page that couldn't be read, with no other signal
A site that refuses automated requests (beacons.ai sits behind a Cloudflare block)
is recorded as refused and left alone: this never tries to get past a block.

State is in .cache/ig-bio-links.sqlite, so a run picks up where the last one
stopped. Matches go to a spreadsheet on the connected Google account through
apps/api/scripts/ig-bio-links-sheet.ts. When that account's API token has lapsed,
the same spreadsheet is written through Chrome on the phone (ig_sheet_phone.py).
From the project root, ig-bio-links.cmd runs all of this: ig-bio-links run --loop
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import random
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.android import (  # noqa: E402
    DEVICE_NAME, INSTAGRAM, Galaxy, Node, PhoneUnavailable, find_adb, instagram_profile_shown,
    user_not_found,
)
from email_finder.cache import Cache  # noqa: E402
from email_finder.config import CACHE_DIR, REPO_ROOT  # noqa: E402
from email_finder.urls import public_url  # noqa: E402
from ig_sheet_phone import SheetError, write_sheet  # noqa: E402

log = logging.getLogger("ig_bio_links")

TARGETS = ("jointherealworld.com/", "university.com/")
DB_PATH = CACHE_DIR / "ig-bio-links.sqlite"
MATCHES_PATH = CACHE_DIR / "ig-bio-links-matches.json"
SUSPECTS_PATH = CACHE_DIR / "ig-bio-links-suspects.json"
SHEET_STATE_PATH = CACHE_DIR / "ig-bio-links-sheet.json"
UPLOADER = REPO_ROOT / "apps" / "api" / "scripts" / "ig-bio-links-sheet.ts"
SHEET_TITLE = "Instagram bio links: jointherealworld.com / university.com"
PROFILE_HEADERS = ["Username", "Profile URL", "Bio link", "Matched prefix", "Full name", "Followers", "Bio",
                   "Found via", "Checked (UTC)"]
SUSPECT_HEADERS = ["Verdict", "Username", "Profile URL", "Bio link", "Link type", "Evidence", "Resolved to",
                   "Full name", "Followers", "Bio", "Found via", "Checked (UTC)"]

SEED_QUERIES = (
    "jointherealworld", "join the real world", "the real world", "therealworld", "real world tate",
    "trw", "trw campus", "trw student", "trw affiliate", "the real world affiliate",
    "official brand partner real world", "hustlers university", "hustlers university affiliate",
    "university.com", "escape the matrix", "escape the slave mind", "top g", "tate university",
    "andrew tate motivation", "tate mindset", "tate quotes", "real world student",
)

PROFILE_GAP = (20.0, 45.0)
SEARCH_SCREENS = 4
CAROUSEL_SWIPES = 2
UPLOAD_EVERY = 10
MAX_FAILURES = 5  # in a row: Instagram or the phone isn't really working

# "tate" and "top g" must start a word, or every realestate and laptop account qualifies.
RELEVANT = re.compile(r"real.?world|\btrw|trw\b|(?<![a-z])tate|andrew.?tate|cobra.?tate|hustler|"
                      r"(?<![a-z])top.?g\b|matrix|jointhe|slave.?mind", re.I)
HANDLE = re.compile(r"^[a-z0-9._]{1,30}$")
QUERY_SAFE = re.compile(r"^[a-z0-9 ._]{2,40}$")
LINK_NODE = re.compile(
    r"^(?P<url>(?:https?://)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#]\S*)?)(?:,? and (?P<more>\d+) more)?$", re.I)
FOLLOWERS = re.compile(r"^([\d.,]+\s?[KMB]?)", re.I)
# Soft blocks that show as a dialog on the normal screen, so the activity name
# check in Galaxy._stopped can't see them.
PUSHBACK = re.compile(r"try again later|we restrict certain|action blocked|unusual activity", re.I)


SHORTENERS = frozenset((
    "bit.ly", "bitly.com", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "is.gd", "v.gd", "buff.ly", "rebrand.ly",
    "cutt.ly", "shorturl.at", "rb.gy", "t.ly", "tiny.cc", "bl.ink", "dub.sh", "s.id", "clck.ru", "soo.gd",
    "qr.ae", "trib.al", "lnkd.in", "shorte.st", "linktw.in", "short.io", "kutt.it", "smarturl.it",
))
LINK_PAGES = frozenset((
    "beacons.ai", "beacons.page", "linktr.ee", "linkin.bio", "lnk.bio", "taplink.cc", "taplink.ws", "campsite.bio",
    "solo.to", "bio.link", "bio.site", "hoo.be", "carrd.co", "stan.store", "koji.to", "withkoji.com", "milkshake.app",
    "msha.ke", "allmylinks.com", "linkpop.com", "shor.by", "flow.page", "tap.bio", "direct.me", "snipfeed.co",
    "linkr.bio", "komi.io", "link.me", "mylinks.ai", "linkfly.to", "linkbio.co", "url.bio", "many.link",
    "contactin.bio", "lynx.bio", "linkin.site", "biolinky.co", "liinks.co", "whop.com",
))
# On a page or in a bio these point to TRW itself; the Tate words only count
# alongside a link built to hide where it goes.
TRW_WORDS = re.compile(r"\btrw|trw\b|real.?world|hustlers?.?uni|jointhe.?real", re.I)
TATE_WORDS = re.compile(r"(?<![a-z])tate|cobra.?tate|(?<![a-z])top.?g\b", re.I)
PAGE_WORDS = re.compile(r"the real world|jointherealworld|hustlers? university|\btrw\b", re.I)
TARGET_IN_TEXT = re.compile(
    r"(?<![a-z0-9.@-])(?:www\.)?(?:jointherealworld\.com|university\.com)/[^\s\"'<>\\)]*", re.I)
SHORT_IN_TEXT = re.compile(
    r"https?://(?:www\.)?(?:" + "|".join(re.escape(h) for h in sorted(SHORTENERS)) + r")/[^\s\"'<>\\)]+", re.I)
META_REFRESH = re.compile(r"http-equiv=[\"']?refresh[\"']?[^>]*?url=['\"]?([^\"'>\s]+)", re.I)
BLOCK_PAGE = re.compile(r"just a moment|attention required|enable javascript and cookies|verify you are human", re.I)
MAX_HOPS = 8
MAX_PAGE_BYTES = 2_000_000
LINK_TRIES = 3  # a link that keeps failing at the network level gets written off
LINKS_PER_STEP = 5
FOLLOW_UA = "Mozilla/5.0 (compatible; ig-bio-links/1.0)"


class Pushback(RuntimeError):
    """Instagram asked for a stop; it has been recorded as a pause."""


def normalize_link(text: str) -> str:
    return re.sub(r"^(?:https?://)?(?:www\.)?", "", text.strip(), flags=re.I)


def matching_target(link: str) -> str | None:
    """The target this link starts with. Anchored, so harvard-university.com/ is no match."""
    low = normalize_link(link).lower()
    return next((t for t in TARGETS if low.startswith(t)), None)


def near_miss(link: str) -> bool:
    """The domain with nothing after it: the requested prefix needs the slash."""
    return normalize_link(link).lower().rstrip("/") + "/" in TARGETS and matching_target(link) is None


def link_kind(link: str) -> str:
    host = (urlsplit("https://" + normalize_link(link)).hostname or "").lower()
    domains = {host, *(host.split(".", i)[-1] for i in range(1, host.count(".")))}
    if domains & SHORTENERS:
        return "shortener"
    return "link page" if domains & LINK_PAGES else "other"


def truncated(link: str) -> bool:
    return link.endswith(("\u2026", "..."))


@dataclass
class Followed:
    final_url: str = ""
    found: str = ""  # the target URL, normalized
    how: str = ""  # "redirect" | "page" | "shortlink on page"
    refused: str = ""  # why it couldn't be read
    words: list[str] = field(default_factory=list)


def scan_page(html: str) -> tuple[str, list[str], list[str]]:
    """(first target URL, TRW words, shortlinks), through JSON and URL escaping."""
    text = unquote(html.replace("\\/", "/"))
    m = TARGET_IN_TEXT.search(text)
    found = normalize_link(m[0].rstrip(".,;")) if m else ""
    words = sorted({w.lower() for w in PAGE_WORDS.findall(text)})
    return found, words, list(dict.fromkeys(SHORT_IN_TEXT.findall(text)))[:5]


def verdict_of(kind: str, followed: Followed, handle: str, name: str, bio: str) -> tuple[str, str]:
    """(verdict, evidence); verdict "" means there is no reason to list the account."""
    if followed.found:
        return "Confirmed", {"redirect": "the link redirects to a target",
                             "page": "the link's page links to a target",
                             "shortlink on page": "a shortlink on its page redirects to a target"}[followed.how]
    note = f" ({followed.refused})" if followed.refused else ""
    if followed.words:
        return "Suspected", "the page mentions " + ", ".join(followed.words)
    about = f"{handle} {name} {bio}"
    if TRW_WORDS.search(about):
        return "Suspected", f"handle, name or bio points to TRW{note}"
    if kind != "other" and TATE_WORDS.search(about):
        return "Suspected", f"Tate-themed account behind a {kind}{note}"
    if kind != "other" and followed.refused:
        return "Unresolved", f"could not read the {kind}{note}"
    return "", ""


async def _get(client: httpx.AsyncClient, url: str) -> tuple[int, str, str]:
    """(status, redirect location, body), with a cap so a huge file can't fill memory."""
    async with client.stream("GET", url) as r:
        if r.is_redirect:
            return r.status_code, r.headers.get("location", ""), ""
        if r.status_code >= 400 or "html" not in r.headers.get("content-type", "").lower():
            return r.status_code, "", ""
        body = b""
        async for chunk in r.aiter_bytes():
            body += chunk
            if len(body) >= MAX_PAGE_BYTES:
                break
        return r.status_code, "", body.decode("utf-8", errors="replace")


def _target_url(url: str) -> str:
    """The normalized URL if it is on a target (the bare domain counts as a redirect's end)."""
    if matching_target(url) or near_miss(url):
        return normalize_link(url).rstrip("/") + "/" if near_miss(url) else normalize_link(url)
    return ""


async def _walk(client: httpx.AsyncClient, url: str) -> tuple[str, str, str, str]:
    """Follow redirects by hand, checking each hop. (final url, target, body, refused)."""
    for _ in range(MAX_HOPS):
        target = _target_url(url)
        if target:
            return url, target, "", ""  # no need to load the target itself
        if not await public_url(url):
            return url, "", "", "the domain doesn't resolve, or isn't a public address"
        status, location, body = await _get(client, url)
        if location:
            url = urljoin(url, location)
            continue
        if status in (401, 403, 429, 503) or (status == 200 and BLOCK_PAGE.search(body[:20000])):
            return url, "", "", f"the site refuses automated requests (HTTP {status})"
        if status >= 400:
            return url, "", "", f"HTTP {status}"
        refresh = META_REFRESH.search(body)
        if refresh:
            url = urljoin(url, refresh[1])
            continue
        return url, "", body, ""
    return url, "", "", "too many redirects"


async def render_page(url: str) -> str:
    """Some link pages build their list in JS. A fresh browser with no signed-in
    profile, used only for known link-page hosts that answered normally."""
    from playwright.async_api import async_playwright

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel="msedge", headless=True)
        try:
            page = await (await browser.new_context()).new_page()
            await page.goto(url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(4000)
            return await page.content()
        finally:
            await browser.close()


async def follow_link(client: httpx.AsyncClient, link: str, render=render_page) -> Followed:
    """Raises httpx.TransportError on a network failure, so the caller can retry."""
    start = link if re.match(r"https?://", link, re.I) else "https://" + link
    final, target, body, refused = await _walk(client, start)
    out = Followed(final_url=final, refused=refused)
    if target:
        out.found, out.how = target, "redirect"
        return out
    if refused:
        return out
    found, words, shorts = scan_page(body)
    if not found and link_kind(final) == "link page":
        try:
            found, more, extra = scan_page(await render(final))
            words = sorted({*words, *more})
            shorts = list(dict.fromkeys(shorts + extra))[:5]
        except Exception as err:  # the plain fetch's answer still stands
            log.info("Could not render %s: %s", final, type(err).__name__)
    out.words = words
    if found:
        out.found, out.how = found, "page"
        return out
    for short in shorts:
        try:
            _, hit, _, _ = await _walk(client, short)
        except httpx.TransportError:
            continue
        if hit:
            out.found, out.how = hit, "shortlink on page"
            break
    return out


@dataclass
class Header:
    links: list[str] = field(default_factory=list)
    more_node: Node | None = None  # the "x.com and 2 more" row, when there is one
    full_name: str = ""
    followers: str = ""
    bio: str = ""


def read_header(nodes: list[Node]) -> Header:
    """The profile header. The link and the bio are unnamed text nodes between the
    counters and the buttons; a whole node must be a URL to count as the link, so
    a URL merely typed into the bio text is not taken for a bio link."""
    ig = [n for n in nodes if n.package == INSTAGRAM and n.bounds[2] > n.bounds[0]]
    head = Header()
    top, bottom = 0, 10 ** 6
    for n in ig:
        rid = n.rid.rsplit("/", 1)[-1]
        if rid.startswith("profile_header_full_name") and not head.full_name:
            head.full_name = n.label
        if rid.startswith("profile_header_followers") or rid == "profile_header_familiar_followers_value":
            top = max(top, n.bounds[3])
            m = FOLLOWERS.match(n.label)
            if m and not head.followers:
                head.followers = m[1].strip()
        if rid in ("profile_header_follow_button", "button_container", "profile_tab_icon_view"):
            bottom = min(bottom, n.bounds[1])
    bio: list[str] = []
    for n in ig:
        if n.rid or n.clickable or not n.label or not top <= n.center[1] <= bottom:
            continue
        m = LINK_NODE.match(n.label.strip())
        if m:
            head.links.append(m["url"])
            if m["more"]:
                head.more_node = n
        else:
            bio.append(n.label.strip())
    head.bio = "\n".join(bio)[:500]
    return head


def links_on_sheet(nodes: list[Node]) -> list[str]:
    """Every URL on the sheet that "x.com and 2 more" opens."""
    found: list[str] = []
    for n in nodes:
        m = LINK_NODE.match(n.label.strip()) if n.package == INSTAGRAM and n.label else None
        if m and "." in m["url"] and not m["more"] and m["url"] not in found:
            found.append(m["url"])
    return found


def search_rows(nodes: list[Node]) -> tuple[list[tuple[str, str]], list[str]]:
    """(username, full name) rows and keyword suggestions on a results screen."""
    users: list[tuple[str, str]] = []
    keywords: list[str] = []
    for i, n in enumerate(nodes):
        if n.package != INSTAGRAM:
            continue
        if n.rid.endswith("/row_search_user_username") and HANDLE.match(n.label):
            after = nodes[i + 1] if i + 1 < len(nodes) else None
            name = after.label if after and after.rid.endswith("/row_search_user_fullname") else ""
            users.append((n.label, name))
        elif n.rid.endswith("/row_search_keyword_title") and n.label:
            keywords.append(n.label.strip().lower())
    return users, keywords


def search_box(nodes: list[Node]) -> Node | None:
    return next((n for n in nodes if n.rid.endswith("/action_bar_search_edit_text")), None)


def suggested_cards(nodes: list[Node]) -> list[tuple[str, str]]:
    """(username, context) from the "Suggested for you" carousel."""
    cards: list[tuple[str, str]] = []
    for i, n in enumerate(nodes):
        if n.package == INSTAGRAM and n.rid.endswith("/suggested_entity_card_name") and HANDLE.match(n.label):
            after = nodes[i + 1] if i + 1 < len(nodes) else None
            context = after.label if after and after.rid.endswith("/suggested_entity_card_context") else ""
            cards.append((n.label, context))
    return cards


def priority_of(handle: str, name: str, from_suggestion: bool) -> int:
    if RELEVANT.search(handle) or RELEVANT.search(name):
        return 0
    return 2 if from_suggestion else 1


# ── state ────────────────────────────────────────────────────────────────────

class Store:
    def __init__(self, path: Path) -> None:
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS profiles (
                username TEXT PRIMARY KEY, priority INTEGER NOT NULL, source TEXT NOT NULL,
                added_at REAL NOT NULL, checked_at REAL, status TEXT NOT NULL DEFAULT 'queued',
                link TEXT, target TEXT, full_name TEXT, followers TEXT, bio TEXT);
            CREATE INDEX IF NOT EXISTS profiles_due ON profiles(status, priority, added_at);
            CREATE TABLE IF NOT EXISTS queries (query TEXT PRIMARY KEY, done_at REAL);
            CREATE TABLE IF NOT EXISTS profile_links (
                username TEXT NOT NULL, link TEXT NOT NULL, PRIMARY KEY (username, link));
            CREATE TABLE IF NOT EXISTS link_checks (
                username TEXT NOT NULL, link TEXT NOT NULL, kind TEXT, verdict TEXT, evidence TEXT,
                final_url TEXT, found_url TEXT, tries INTEGER NOT NULL DEFAULT 0, checked_at REAL,
                PRIMARY KEY (username, link));
        """)

    def add_profile(self, handle: str, priority: int, source: str) -> None:
        with self.db:
            self.db.execute("INSERT OR IGNORE INTO profiles (username, priority, source, added_at) "
                            "VALUES (?, ?, ?, ?)", (handle, priority, source[:120], time.time()))
            # A better route to a waiting candidate moves it up the queue.
            self.db.execute("UPDATE profiles SET priority = ? WHERE username = ? AND status = 'queued' "
                            "AND priority > ?", (priority, handle, priority))

    def add_query(self, query: str) -> None:
        if QUERY_SAFE.match(query):
            with self.db:
                self.db.execute("INSERT OR IGNORE INTO queries (query) VALUES (?)", (query,))

    def next_profile(self, max_priority: int) -> str | None:
        row = self.db.execute("SELECT username FROM profiles WHERE status = 'queued' AND priority <= ? "
                              "ORDER BY priority, added_at LIMIT 1", (max_priority,)).fetchone()
        return row["username"] if row else None

    def next_query(self, skip: frozenset[str] | set[str] = frozenset()) -> str | None:
        rows = self.db.execute("SELECT query FROM queries WHERE done_at IS NULL ORDER BY rowid").fetchall()
        return next((r["query"] for r in rows if r["query"] not in skip), None)

    def query_done(self, query: str) -> None:
        with self.db:
            self.db.execute("UPDATE queries SET done_at = ? WHERE query = ?", (time.time(), query))

    def record(self, handle: str, status: str, link: str | None = None, target: str | None = None,
               head: Header | None = None) -> None:
        head = head or Header()
        with self.db:
            self.db.execute(
                "UPDATE profiles SET status = ?, checked_at = ?, link = ?, target = ?, full_name = ?, "
                "followers = ?, bio = ? WHERE username = ?",
                (status, time.time(), link, target, head.full_name, head.followers, head.bio, handle))

    def add_links(self, handle: str, links: list[str]) -> None:
        with self.db:
            self.db.executemany("INSERT OR IGNORE INTO profile_links VALUES (?, ?)",
                                [(handle, normalize_link(link)) for link in links])

    def pending_links(self, limit: int) -> list[sqlite3.Row]:
        return self.db.execute(
            "SELECT p.username, l.link, p.full_name, p.bio FROM profiles p JOIN ("
            "  SELECT username, link FROM profile_links"
            "  UNION SELECT username, link FROM profiles WHERE link IS NOT NULL) l ON l.username = p.username "
            "LEFT JOIN link_checks c ON c.username = l.username AND c.link = l.link "
            "WHERE p.status = 'done' AND c.checked_at IS NULL AND COALESCE(c.tries, 0) < ? "
            "ORDER BY COALESCE(c.tries, 0), p.checked_at LIMIT ?", (LINK_TRIES, limit)).fetchall()

    def link_failed(self, handle: str, link: str) -> int:
        with self.db:
            self.db.execute("INSERT INTO link_checks (username, link, tries) VALUES (?, ?, 1) "
                            "ON CONFLICT (username, link) DO UPDATE SET tries = tries + 1", (handle, link))
        return self.db.execute("SELECT tries FROM link_checks WHERE username = ? AND link = ?",
                               (handle, link)).fetchone()[0]

    def save_check(self, handle: str, link: str, kind: str, verdict: str, evidence: str,
                   final_url: str = "", found_url: str = "") -> None:
        with self.db:
            self.db.execute(
                "INSERT INTO link_checks (username, link, kind, verdict, evidence, final_url, found_url, checked_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (username, link) DO UPDATE SET kind = excluded.kind, "
                "verdict = excluded.verdict, evidence = excluded.evidence, final_url = excluded.final_url, "
                "found_url = excluded.found_url, checked_at = excluded.checked_at",
                (handle, link, kind, verdict, evidence, final_url, found_url, time.time()))

    def suspects(self) -> list[dict]:
        rows = self.db.execute(
            "SELECT c.*, p.full_name, p.followers, p.bio, p.source FROM link_checks c "
            "JOIN profiles p ON p.username = c.username WHERE c.verdict IN ('Confirmed', 'Suspected', 'Unresolved') "
            "ORDER BY c.checked_at").fetchall()
        return [dict(r) for r in rows]

    def matches(self) -> list[dict]:
        rows = self.db.execute("SELECT * FROM profiles WHERE target IS NOT NULL ORDER BY checked_at").fetchall()
        return [dict(r) for r in rows]

    def counts(self) -> dict[str, int]:
        one = lambda sql: self.db.execute(sql).fetchone()[0]  # noqa: E731
        return {
            "matches": one("SELECT count(*) FROM profiles WHERE target IS NOT NULL"),
            "checked": one("SELECT count(*) FROM profiles WHERE status = 'done'"),
            "missing": one("SELECT count(*) FROM profiles WHERE status = 'missing'"),
            "near_misses": one("SELECT count(*) FROM profiles WHERE status = 'done' AND target IS NULL AND "
                               "lower(rtrim(replace(replace(link,'https://',''),'www.',''),'/')) "
                               "IN ('jointherealworld.com','university.com')"),
            "queued": one("SELECT count(*) FROM profiles WHERE status = 'queued'"),
            "queries_left": one("SELECT count(*) FROM queries WHERE done_at IS NULL"),
            "via_links": one("SELECT count(*) FROM link_checks WHERE verdict = 'Confirmed'"),
            "suspected": one("SELECT count(*) FROM link_checks WHERE verdict = 'Suspected'"),
            "unresolved": one("SELECT count(*) FROM link_checks WHERE verdict = 'Unresolved'"),
        }


# ── the phone ────────────────────────────────────────────────────────────────

class Scanner:
    def __init__(self, galaxy: Galaxy, store: Store) -> None:
        self.g, self.store = galaxy, store
        self.since_upload = 0

    def paused_for(self) -> float:
        return max(self.g.phone_paused_for(), self.g.paused_for("instagram"))

    async def _check(self, nodes: list[Node] | None = None) -> None:
        if await self.g._stopped("instagram"):
            raise Pushback("Instagram is showing a security or login screen")
        if nodes and any(n.package == INSTAGRAM and n.label and PUSHBACK.search(n.label) for n in nodes):
            self.g._pause("instagram", "a 'try again later' notice")
            raise Pushback("Instagram showed a 'try again later' notice")

    async def visit(self, handle: str) -> None:
        """Open one profile, record what its bio link says, collect suggestions on a match."""
        await self._check()
        nodes: list[Node] = []
        for attempt in range(2):  # a "user not found" gets a second look before it counts
            await self.g._input(f"am start -a android.intent.action.VIEW "
                                f"-d https://www.instagram.com/{handle}/ -p {INSTAGRAM}")
            await asyncio.sleep(1)
            nodes = await self.g._until_profile_shown(handle)
            await self._check(nodes)
            if instagram_profile_shown(nodes, handle):
                break
            if attempt == 1:
                if user_not_found(nodes):
                    self.store.record(handle, "missing")
                    log.info("@%s: not found", handle)
                    return
                raise PhoneUnavailable(f"@{handle} did not open")
            await asyncio.sleep(2)
        await asyncio.sleep(2)  # the link row can draw after the counters
        nodes = await self.g._screen()
        await self._check(nodes)
        if not instagram_profile_shown(nodes, handle):
            raise PhoneUnavailable(f"left @{handle} before reading it")
        head = read_header(nodes)
        links = list(head.links)
        if head.more_node and not any(matching_target(link) for link in links):
            links += await self._open_more_links(head.more_node, handle)
        hit = next((link for link in links if matching_target(link)), None)
        shown = hit or next((link for link in links if near_miss(link)), links[0] if links else None)
        self.store.add_links(handle, links)
        self.store.record(handle, "done", shown and normalize_link(shown),
                          matching_target(hit) if hit else None, head)
        log.info("@%s: %s", handle, f"MATCH {normalize_link(hit)}" if hit else (shown or "no link"))
        if hit:
            self.since_upload += 1
        # A TRW-looking account behind bit.ly has the same kind of neighbours.
        if hit or (links and TRW_WORDS.search(f"{handle} {head.full_name} {head.bio}")):
            await self._collect_suggestions(handle)

    async def _open_more_links(self, row: Node, handle: str) -> list[str]:
        """Only this row is ever tapped: a single-link row would open the browser."""
        await self.g._tap(row)
        await asyncio.sleep(3)
        await self._check()
        if not (await self.g._foreground()).startswith(INSTAGRAM):
            await self.g._key("KEYCODE_BACK")  # it opened a page, not the list
            await asyncio.sleep(2)
            return []
        nodes = await self.g._screen()
        links = links_on_sheet(nodes)
        await self.g._key("KEYCODE_BACK")
        await asyncio.sleep(1)
        if not instagram_profile_shown(await self.g._screen(), handle):
            log.info("@%s: the link list did not close cleanly", handle)
        return links

    async def _collect_suggestions(self, handle: str) -> None:
        nodes = await self.g._screen()
        arrow = next((n for n in nodes if n.rid.endswith("/row_profile_header_button_chaining")), None)
        if not arrow:
            return
        await self.g._tap(arrow)
        await asyncio.sleep(4)
        width, _ = await self.g._geometry()
        seen = 0
        for swipe in range(CAROUSEL_SWIPES + 1):
            nodes = await self.g._screen()
            await self._check(nodes)
            cards = suggested_cards(nodes)
            for card, context in cards:
                self.store.add_profile(card, priority_of(card, context, True), f"suggested by @{handle}")
                seen += 1
            names = [n for n in nodes if n.rid.endswith("/suggested_entity_card_name")]
            if not names or swipe == CAROUSEL_SWIPES:
                break
            y = names[0].center[1]  # the name line: no button sits under this swipe
            await self.g._input(f"input swipe {int(width * .9)} {y} {int(width * .1)} {y} 400")
            await asyncio.sleep(2)
        log.info("@%s: %d suggested account(s) read", handle, seen)

    async def search(self, query: str) -> None:
        await self._check()
        await self.g._shell(f"am start --activity-clear-top -n {await self.g._launcher_component()}")
        await asyncio.sleep(4)
        nodes = await self.g._screen()
        await self._check(nodes)
        box = search_box(nodes)
        if box:  # the app reopens on the last search, with no tab bar
            clear = next((n for n in nodes if n.package == INSTAGRAM and n.label == "Clear text"), None)
            if clear:
                await self.g._tap(clear)
                await asyncio.sleep(1)
        else:
            tab = next((n for n in nodes if n.rid.endswith("/search_tab")), None)
            if not tab:
                raise PhoneUnavailable("the Search tab is not on screen")
            await self.g._tap(tab)
            await asyncio.sleep(3)
            box = search_box(await self.g._screen())
            if not box:
                raise PhoneUnavailable("the search box is not on screen")
        await self.g._tap(box)
        await asyncio.sleep(2)
        await self.g._input("input text " + query.replace(" ", "%s"))
        await asyncio.sleep(5)
        width, height = await self.g._geometry()
        users = keywords = 0
        for screen in range(SEARCH_SCREENS):
            nodes = await self.g._screen()
            await self._check(nodes)
            if screen == 0 and (shown := search_box(nodes)) and shown.label != query:
                raise PhoneUnavailable(f"the search box says {shown.label!r}, not {query!r}")
            if screen == 0 and not shown:
                raise PhoneUnavailable("the search box left the screen")
            rows, words = search_rows(nodes)
            for handle, name in rows:
                self.store.add_profile(handle, priority_of(handle, name, False), f"search: {query}")
                users += 1
            for word in words:
                if RELEVANT.search(word):
                    self.store.add_query(word)
                    keywords += 1
            x = width // 2
            await self.g._input(f"input swipe {x} {int(height * .55)} {x} {int(height * .2)} 400")
            await asyncio.sleep(2.5)
        self.store.query_done(query)
        log.info("search %r: %d account row(s), %d related keyword(s)", query, users, keywords)

    async def with_phone(self, step) -> bool:
        """Run one step holding the worker's phone lock. False when it isn't free."""
        if not await self.g.available():
            log.info("%s is locked or off USB", DEVICE_NAME)
            return False
        if not await self.g._hold_phone(150):
            log.info("%s is busy with another process", DEVICE_NAME)
            return False
        try:
            await step
            return True
        finally:
            await self.g._leave("home")
            self.g._release_phone()


# ── following links ──────────────────────────────────────────────────────────

async def resolve_links(store: Store, limit: int | None = None) -> int:
    """Check waiting links from the PC (the phone is not involved). Returns how many
    were settled; a link that fails at the network level is tried again later."""
    settled = 0
    client = httpx.AsyncClient(follow_redirects=False, timeout=15, headers={"User-Agent": FOLLOW_UA})
    try:
        while limit is None or settled < limit:
            rows = store.pending_links(LINKS_PER_STEP if limit is None else limit - settled)
            if not rows:
                break
            for row in rows:
                handle, link = row["username"], row["link"]
                kind = link_kind(link)
                name, bio = row["full_name"] or "", row["bio"] or ""
                if matching_target(link):  # already on the Profiles tab
                    store.save_check(handle, link, kind, "Direct", "the bio link itself matches")
                elif near_miss(link):
                    store.save_check(handle, link, kind, "Confirmed", "the bio link is the bare domain, with no path",
                                     found_url=normalize_link(link).rstrip("/") + "/")
                elif truncated(link):
                    verdict, why = verdict_of(kind, Followed(refused="Instagram shows the link cut short"),
                                              handle, name, bio)
                    store.save_check(handle, link, kind, verdict, why)
                else:
                    try:
                        followed = await follow_link(client, link)
                    except httpx.TransportError as err:
                        tries = store.link_failed(handle, link)
                        log.info("%s: %s (try %d of %d)", link, type(err).__name__, tries, LINK_TRIES)
                        if tries < LINK_TRIES:
                            continue
                        followed = Followed(refused="the site could not be reached")
                    verdict, why = verdict_of(kind, followed, handle, name, bio)
                    store.save_check(handle, link, kind, verdict, why, followed.final_url, followed.found)
                    await asyncio.sleep(1)
                settled += 1
                saved = store.db.execute("SELECT verdict, evidence FROM link_checks WHERE username = ? AND link = ?",
                                         (handle, link)).fetchone()
                log.info("@%s %s: %s", handle, link, f"{saved[0]}: {saved[1]}" if saved[0] else "nothing points to TRW")
    finally:
        await client.aclose()
    return settled


# ── upload ───────────────────────────────────────────────────────────────────

def sheet_tabs(rows: list[dict], suspects: list[dict]) -> list[dict]:
    """The phone writer's view of the same two tabs the API uploader writes. Suspects are
    keyed on account and link: one account can show several, and many accounts can share one."""
    profile = "https://www.instagram.com/{}/".format
    return [
        {"name": "Profiles", "headers": PROFILE_HEADERS, "key_columns": "B", "key_indexes": (1,),
         "rows": [[m["username"], profile(m["username"]), m["link"], m["target"], m["fullName"], m["followers"],
                   m["bio"], m["source"], m["checkedAt"]] for m in rows]},
        {"name": "Suspected TRW", "headers": SUSPECT_HEADERS, "key_columns": "CD", "key_indexes": (2, 3),
         "rows": [[m["verdict"], m["username"], profile(m["username"]), m["link"], m["kind"], m["evidence"],
                   m["resolvedTo"], m["fullName"], m["followers"], m["bio"], m["source"], m["checkedAt"]]
                  for m in suspects]},
    ]


async def upload_by_phone(rows: list[dict], suspects: list[dict], serial: str | None) -> bool:
    adb = find_adb()
    if not adb:
        log.error("adb was not found, so the sheet was not updated through the phone.")
        return False
    galaxy = Galaxy(Cache(CACHE_DIR / "engine.sqlite"), adb, serial)
    try:
        log.info("%s", await write_sheet(galaxy, adb, serial, SHEET_STATE_PATH, SHEET_TITLE,
                                         sheet_tabs(rows, suspects)))
        return True
    except (SheetError, PhoneUnavailable, OSError, asyncio.TimeoutError, httpx.HTTPError) as err:
        log.error("Writing the sheet through the phone failed: %s", err)
        return False


async def upload(store: Store, serial: str | None = None) -> bool:
    rows = [{"username": m["username"], "link": m["link"], "target": m["target"],
             "fullName": m["full_name"] or "", "followers": m["followers"] or "", "bio": m["bio"] or "",
             "source": m["source"], "checkedAt": time.strftime("%Y-%m-%d %H:%M", time.gmtime(m["checked_at"]))}
            for m in store.matches()]
    suspects = [{"verdict": s["verdict"], "username": s["username"], "link": s["link"], "kind": s["kind"] or "",
                 "evidence": s["evidence"] or "", "resolvedTo": s["found_url"] or s["final_url"] or "",
                 "fullName": s["full_name"] or "", "followers": s["followers"] or "", "bio": s["bio"] or "",
                 "source": s["source"], "checkedAt": time.strftime("%Y-%m-%d %H:%M", time.gmtime(s["checked_at"]))}
                for s in store.suspects()]
    if not rows and not suspects:
        log.info("No matches to upload yet.")
        return True
    MATCHES_PATH.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    SUSPECTS_PATH.write_text(json.dumps(suspects, ensure_ascii=False, indent=1), encoding="utf-8")
    npx = shutil.which("npx")
    if not npx:
        log.info("npx is not on PATH; writing the sheet through the phone instead.")
        return await upload_by_phone(rows, suspects, serial)
    done = subprocess.run(
        [npx, "tsx", str(UPLOADER), f"--in={MATCHES_PATH}", f"--suspects={SUSPECTS_PATH}", f"--state={SHEET_STATE_PATH}"],
        cwd=UPLOADER.parent.parent, capture_output=True, text=True, encoding="utf-8", errors="replace",
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0)
    lines = [ln for ln in done.stdout.splitlines() if ln.startswith("SHEET ")]
    if done.returncode or not lines:
        log.info("Google API upload unavailable (%s); writing the sheet through the phone instead.",
                 (done.stderr or done.stdout).strip()[-160:])
        return await upload_by_phone(rows, suspects, serial)
    log.info("%s", lines[-1])
    return True


# ── the run ──────────────────────────────────────────────────────────────────

async def run(args: argparse.Namespace) -> None:
    store = Store(DB_PATH)
    for query in SEED_QUERIES:
        store.add_query(query)
    adb = find_adb()
    if not adb:
        raise SystemExit("adb was not found")
    galaxy = Galaxy(Cache(CACHE_DIR / "engine.sqlite"), adb, args.serial)
    scanner = Scanner(galaxy, store)
    cache = galaxy.cache
    opened, failures = 0, 0
    tries: dict[str, int] = {}
    skip_queries: set[str] = set()
    try:
        while args.limit is None or opened < args.limit:
            wait = scanner.paused_for()
            why = "Instagram or the phone is paused after a security check; clear it on the phone"
            if not wait and cache.count("ig-bio") >= args.daily_limit:
                wait, why = 86400 - time.time() % 86400, "today's profile budget is spent"
            if wait:
                log.info("Stopping: %s (%.1f h).", why, wait / 3600)
                if not args.loop:
                    return
                await upload(store, args.serial)
                await asyncio.sleep(wait + 60)
                continue

            # The obvious names first, then new searches, then everything else.
            handle = store.next_profile(0)
            query = None
            if not handle:
                query = (store.next_query(skip_queries)
                         if cache.count("ig-bio-search") < args.searches_per_day else None)
                if not query:
                    handle = store.next_profile(9)
            if not handle and not query:
                if store.next_query(skip_queries):
                    wait = 86400 - time.time() % 86400
                    log.info("Queue empty and today's searches are spent (%.1f h).", wait / 3600)
                    if args.loop:
                        await asyncio.sleep(wait + 60)
                        continue
                else:
                    log.info("No candidates left: every search and suggestion has been checked.")
                return

            try:
                if query:
                    cache.reserve("ig-bio-search", args.searches_per_day)
                    log.info("Searching the app for %r", query)
                    step = scanner.search(query)
                else:
                    cache.reserve("ig-bio", args.daily_limit)
                    step = scanner.visit(handle)
                if not await scanner.with_phone(step):
                    step.close()
                    failures += 1
                else:
                    failures = 0
                    if handle:
                        opened += 1
            except Pushback as err:
                log.warning("%s. It stays paused until cleared on the phone.", err)
                if not args.loop:
                    return
                continue
            except PhoneUnavailable as err:
                log.info("%s", err)
                failures += 1
                # One stubborn profile or search must not hold up the queue. A
                # search stays unfinished for the next run: this failure may have
                # been the phone rather than the search.
                key = query or handle
                tries[key] = tries.get(key, 0) + 1
                if tries[key] >= 2:
                    if query:
                        skip_queries.add(query)
                    else:
                        store.record(handle, "unopened")
            if failures >= MAX_FAILURES:
                log.error("Stopping after %d failed steps in a row.", failures)
                return
            try:
                await resolve_links(store, LINKS_PER_STEP)
            except Exception:  # following links must never stop the scan
                log.exception("Following links failed; they stay queued")
            if scanner.since_upload >= UPLOAD_EVERY and await upload(store, args.serial):
                scanner.since_upload = 0
            await asyncio.sleep(random.uniform(*PROFILE_GAP) * (1 + failures))
    finally:
        try:
            await resolve_links(store)
        except Exception:
            log.exception("Following links failed; they stay queued")
        await upload(store, args.serial)
        log.info("Totals: %s", store.counts())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    go = sub.add_parser("run")
    go.add_argument("--limit", type=int, help="profiles to open this run")
    go.add_argument("--daily-limit", type=int, default=150, help="profiles per UTC day (default 150)")
    go.add_argument("--searches-per-day", type=int, default=30)
    go.add_argument("--loop", action="store_true", help="wait out budgets and pauses instead of exiting")
    go.add_argument("--serial", default=None, help="adb serial, when several phones are attached")
    add = sub.add_parser("add")
    add.add_argument("handles", nargs="+")
    sub.add_parser("resolve")
    sub.add_parser("upload")
    sub.add_parser("report")
    args = parser.parse_args()

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=[
        logging.StreamHandler(), logging.FileHandler(CACHE_DIR / "ig-bio-links.log", encoding="utf-8")])
    logging.getLogger("httpx").setLevel(logging.WARNING)

    if args.command == "run":
        asyncio.run(run(args))
        return
    store = Store(DB_PATH)
    if args.command == "add":
        for handle in args.handles:
            handle = handle.strip().lstrip("@").lower()
            if HANDLE.match(handle):
                store.add_profile(handle, 0, "added by hand")
    elif args.command == "resolve":
        asyncio.run(resolve_links(store))
    elif args.command == "upload":
        raise SystemExit(0 if asyncio.run(upload(store)) else 1)
    print(json.dumps(store.counts(), indent=1))


if __name__ == "__main__":
    main()
