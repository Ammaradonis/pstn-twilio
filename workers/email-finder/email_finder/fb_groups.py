"""Facebook groups on the same phone: find, join, then engage slowly.

The shape is `android.py`'s, because that shape is what makes the Instagram
work defensible:

* Only reads the screen (UiAutomator hierarchy) and taps controls it has just
  seen in a fresh dump. A screen that cannot be read is never guessed at.
* Reads are retried; input commands never are. A tap that may have landed twice
  is worse than a missed one.
* A security checkpoint stops everything: the app is paused, the phone is
  paused, and the user clears it by hand.
* Every state-changing action is verified against a new dump afterwards, and a
  failure is reported rather than retried blindly.

What is new here is text. Instagram's session never typed anything; a comment
has to be typed into a composer, which means a sanitizer, a submit-verify step,
and the strictest caps in the repo (see `fb_engage.py`).

Navigation is URL-first (`am start -a android.intent.action.VIEW -d ... -p
com.facebook.katana`) rather than tapped: Facebook's search box moves between
releases, its deep links do not, and a URL that fails is a cheap failure.
"""

from __future__ import annotations

import asyncio
import logging
import random
import re
import time
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING, Iterable

from .android import Node, PhoneUnavailable, STOP_SCREEN, CHALLENGE_SCREEN, find_button
from .fb_vocab import MEMBERS, MEMBER_WORD, GroupCandidate, SearchTerm, parse_members, \
    score_group, keep, term_key

if TYPE_CHECKING:  # pragma: no cover
    from .android import Galaxy

log = logging.getLogger(__name__)

FACEBOOK = "com.facebook.katana"
MESSENGER = "com.facebook.orca"

SEARCH_URL = "https://www.facebook.com/search/groups/?q={query}"
GROUP_URL = "https://www.facebook.com/groups/{group}"
MESSAGES_URL = "https://www.facebook.com/messages/"
SEARCH_SETTLE_S = 6.0
PAGE_SETTLE_S = 4.0
COMPOSER_WAIT_S = 5.0
MAX_SEARCH_SCROLLS = 4

# ── labels ───────────────────────────────────────────────────────────────────
# Facebook ships copy per market, so every label list carries the variants we
# have seen. Exact matches only: a menu that says "Join" also says "Leave".
JOIN_LABELS = {"join", "join group", "join this group"}
JOINED_LABELS = {"joined", "requested", "cancel request", "leave group", "joined group"}
LIKE_LABELS = {"like", "remove like", "unlike"}
COMMENT_LABELS = {"comment", "write a comment", "write a public comment", "add a comment",
                  "comment as"}
REPLY_LABELS = {"reply", "replies"}
FOLLOW_LABELS = {"follow"}
FOLLOWING_LABELS = {"following", "unfollow"}
MESSAGE_LABELS = {"message", "send message", "message me"}
SUBMIT_LABELS = {"post", "send", "comment", "reply", "publish"}
MORE_LABELS = {"see more", "more", "see all"}
MEMBER_WORDS = ("member", "members", "followers")
PRIVACY = re.compile(r"\b(public|private)\b", re.I)
GROUP_SUFFIX = re.compile(r"\b(group|community|owners?|instructors?|network|hub|forum)\b", re.I)
POST_MARKERS = {"like", "comment", "share", "send"}
# Text that belongs to the interface, never to a post or a group's name.
UI_NOISE = {
    "facebook", "groups", "search", "results", "public group", "private group", "members",
    "posts", "about", "discussion", "featured", "people", "photos", "videos", "files",
    "events", "member requests", "joined", "join", "join group", "requested", "like",
    "comment", "share", "send", "reply", "follow", "following", "message", "more",
    "see more", "see all", "cancel", "post", "write a comment", "write something",
    "recent activity", "new posts", "popular", "invite", "notifications", "menu", "back",
}
# Words that make a link unsafe to follow automatically: a group whose name says
# "buy and sell" or "jobs" is not a group of school owners.
NOISE_NAME = re.compile(r"buy[\s/-]*(?:and\s*)?sell|swap|marketplace|classifieds|for sale|"
                        r"\bjobs?\b|hiring|rent|housing|dating|singles|memes|crypto|casino|"
                        r"coupon|promo code", re.I)
# Facebook's own security copy. A checkpoint means the phone goes quiet; a login
# screen means only that the app needs signing in again.
CHALLENGE_SCREEN_TEXT = re.compile(
    r"security check|checkpoint|confirm your identity|confirm it.s you|we need to confirm|"
    r"unusual activity|suspicious activity|two[-\s]?factor|verification code|captcha|"
    r"verify your account", re.I)
LOGIN_SCREEN_TEXT = re.compile(r"\blog ?in\b|sign up|create (?:a )?new account|"
                               r"forgot (?:your )?password", re.I)


# ── reading a screen ─────────────────────────────────────────────────────────


def visible(nodes: Iterable[Node], package: str = FACEBOOK) -> list[Node]:
    """The nodes that are actually on screen, in reading order."""
    shown = [n for n in nodes if n.package.startswith(package)
             and n.bounds[2] > n.bounds[0] and n.bounds[3] > n.bounds[1] and n.label]
    return sorted(shown, key=lambda n: (n.bounds[1], n.bounds[0]))


def bands(nodes: list[Node], gap: int = 20, max_height: float = 0.0) -> list[list[Node]]:
    """Cluster nodes into cards: one search result, one post, one comment each.

    Facebook stacks a card's lines with small gaps and separates cards with much
    larger ones, and it changes resource ids between releases, so vertical
    geometry is the only stable handle. A band grows while the next node starts
    within `gap` pixels of the band's bottom; `max_height` caps a band so a feed
    post that contains its own comments cannot swallow the screen.
    """
    rows: list[list[Node]] = []
    bottom = top = 0
    for node in sorted(nodes, key=lambda n: (n.bounds[1], n.bounds[0])):
        node_top, node_bottom = node.bounds[1], node.bounds[3]
        fits = (rows and node_top <= bottom + gap
                and (not max_height or node_bottom - top <= max_height))
        if fits:
            rows[-1].append(node)
            bottom = max(bottom, node_bottom)
        else:
            rows.append([node])
            bottom, top = node_bottom, node_top
    return [row for row in rows if row]


def screen_height(nodes: list[Node]) -> int:
    return max((n.bounds[3] for n in nodes), default=0)


def labels(row: list[Node]) -> list[str]:
    return [n.label.strip() for n in row if n.label.strip()]


def is_ui(text: str) -> bool:
    return text.casefold().strip() in UI_NOISE


def longest_text(row: list[Node]) -> str:
    """The most word-like label in a row: a group name or a post's opening."""
    candidates = [n.label.strip() for n in row
                  if not is_ui(n.label) and not MEMBERS.search(n.label)
                  and not PRIVACY.fullmatch(n.label.strip())]
    if not candidates:
        return ""
    return max(candidates, key=lambda text: (len(text.split()), len(text)))


def group_rows(nodes: list[Node]) -> list[GroupCandidate]:
    """Group search results -> candidates, with member counts when shown.

    The name is the longest sensible text in the card; the URL is the clickable
    node's own hint when Facebook exposes one, and is left empty otherwise
    rather than invented.
    """
    out: list[GroupCandidate] = []
    seen: set[str] = set()
    height = screen_height(visible(nodes))
    for row in bands(visible(nodes), gap=18, max_height=height * 0.30):
        name = longest_text(row)
        if not name or len(name) < 3 or not name[0].isalnum():
            continue
        if name.casefold() in seen:
            continue
        if not GROUP_SUFFIX.search(name) and not NOISE_NAME.search(name):
            # A card with no group-ish word and no obvious noise is probably a
            # heading or a "People also search for"; skip it quietly.
            continue
        members = 0
        for node in row:
            found = MEMBERS.search(node.label)
            if found:
                members = parse_members(found.group(0))
                break
        privacy = ""
        for node in row:
            found = PRIVACY.search(node.label)
            if found:
                privacy = found.group(1).casefold()
                break
        candidate = score_group(name, None, members)
        candidate.url = _url_hint(row)
        candidate.privacy = privacy
        seen.add(name.casefold())
        out.append(candidate)
    return out


def _url_hint(row: list[Node]) -> str:
    """A group URL if Facebook put one in the hierarchy, else ""."""
    for node in row:
        for text in (node.desc, node.text):
            found = re.search(r"facebook\.com/groups/([A-Za-z0-9._-]+)", text)
            if found:
                return GROUP_URL.format(group=found.group(1))
    return ""


def join_control(nodes: list[Node]) -> tuple[Node | None, str]:
    """The Join button, or the state that says there is nothing to tap."""
    for node in nodes:
        label = node.label.casefold().strip()
        if label in JOIN_LABELS and node.clickable:
            return node, "joinable"
        if label in JOINED_LABELS:
            return None, label
    return None, ""


def search_box(nodes: list[Node]) -> Node | None:
    """Facebook's search field, if the deep link left us on the search page."""
    for node in nodes:
        rid = node.rid.casefold()
        if ("search" in rid and ("edit" in rid or "text" in rid)) and node.clickable:
            return node
    return find_button(nodes, "Search", "Search Facebook")


def post_rows(nodes: list[Node]) -> list[tuple[str, str]]:
    """Feed posts as (author, text) pairs, in the order they appear.

    A post band is recognised by carrying at least one of Like/Comment/Share.
    The author is the shortest label above the body; the body is the longest.
    """
    out: list[tuple[str, str]] = []
    height = screen_height(visible(nodes))
    for row in bands(visible(nodes), gap=14, max_height=height * 0.62):
        texts = labels(row)
        folded = {text.casefold() for text in texts}
        if not folded & POST_MARKERS:
            continue
        body = longest_text(row)
        if not body or len(body.split()) < 6:
            continue
        author = next((text for text in texts
                       if not is_ui(text) and 2 <= len(text.split()) <= 5
                       and text.casefold() != body.casefold()), "")
        out.append((author, body))
    return out


def comment_controls(nodes: list[Node]) -> list[Node]:
    return [n for n in nodes if n.label.casefold().strip() in COMMENT_LABELS and n.clickable]


def reply_controls(nodes: list[Node]) -> list[Node]:
    return [n for n in nodes if n.label.casefold().strip() in REPLY_LABELS and n.clickable]


def comment_rows(nodes: list[Node]) -> list[tuple[str, str, Node | None]]:
    """Comments as (author, text, reply-control) triples.

    A comment band is the only band on a post that carries a Reply control. The
    author is the short label at the top of that band, the text is the longest,
    and the Reply control is returned so the driver can tap *that* one rather
    than the first Reply on the page.
    """
    out: list[tuple[str, str, Node | None]] = []
    height = screen_height(visible(nodes))
    for row in bands(visible(nodes), gap=14, max_height=height * 0.30):
        reply = next((n for n in row if n.label.casefold().strip() in REPLY_LABELS
                      and n.clickable), None)
        if reply is None:
            continue
        texts = [n.label.strip() for n in row
                 if n.label.strip() and not is_ui(n.label)
                 and n.label.casefold().strip() not in REPLY_LABELS]
        if not texts:
            continue
        body = max(texts, key=lambda text: (len(text.split()), len(text)))
        author = next((text for text in texts if text.casefold() != body.casefold()
                       and 1 <= len(text.split()) <= 4), "")
        if len(body.split()) >= 3:
            out.append((author, body, reply))
    return out


def submit_control(nodes: list[Node]) -> Node | None:
    """The Post/Send button inside an open composer, never the feed's own Post."""
    for node in nodes:
        if node.label.casefold().strip() in SUBMIT_LABELS and node.clickable:
            if node.bounds[1] > 0 and node.bounds[3] < 10_000:
                return node
    return None


def composer(nodes: list[Node]) -> Node | None:
    """The comment field. Facebook marks it with an EditText rid or a prompt."""
    for node in nodes:
        rid = node.rid.casefold()
        if FACEBOOK in rid and ("edit_text" in rid or "composer" in rid or "comment_box" in rid):
            return node
    for node in nodes:
        if node.clickable and "write a comment" in node.label.casefold():
            return node
        if node.clickable and node.label.casefold().startswith("comment as"):
            return node
    return None


def challenge_kind(nodes: list[Node]) -> str:
    """'challenge' | 'login' | '' — from what is on screen, not from the activity.

    Facebook's checkpoint copy is not Instagram's, so it gets its own patterns;
    the shared `STOP_SCREEN` is kept as a net for anything either app reuses.
    """
    for node in nodes:
        if not node.package.startswith(FACEBOOK):
            continue
        label = node.label
        if CHALLENGE_SCREEN_TEXT.search(label):
            return "challenge"
        if LOGIN_SCREEN_TEXT.search(label):
            return "login"
        if STOP_SCREEN.search(label) and CHALLENGE_SCREEN.search(label):
            return "challenge"
        if STOP_SCREEN.search(label):
            return "login"
    return ""


# ── typing ───────────────────────────────────────────────────────────────────

# `input text` is a shell command with its own escaping rules, and the strings
# we send are model-written prose. The sanitizer is deliberately conservative:
# a comment that loses a curly quote is fine, a comment that executes a shell
# fragment is not.
SHELL_UNSAFE = re.compile(r"[&|;<>$`\\\"'!*?()\[\]{}~^]")
SMART = {"\u2019": "'", "\u2018": "'", "\u201c": '"', "\u201d": '"',
         "\u2013": "-", "\u2014": "-", "\u2026": "...", "\u00a0": " "}


def sanitize(text: str, limit: int = 1200) -> str:
    """Make model prose safe to pass through `adb shell input text`.

    Newlines would submit the comment early, so they become spaces; so does
    every character that could terminate or redirect the shell command. This is
    the fallback path: `clean_text` is used whenever UiAutomator can type, and it
    keeps the quotes that make a comment read like a person.
    """
    return _trim(re.sub(r"\s+", " ", SHELL_UNSAFE.sub("", _tidy(text))).strip(), limit)


def _tidy(text: str) -> str:
    """Everything both typing paths want: no smart quotes, no newlines."""
    body = (text or "").strip()
    for bad, good in SMART.items():
        body = body.replace(bad, good)
    return body.replace("\r", " ").replace("\n", " ")


def _trim(body: str, limit: int) -> str:
    if len(body) <= limit:
        return body
    cut = body[:limit]
    return cut.rsplit(" ", 1)[0].rstrip(" ,;:-") + "."


def clean_text(text: str, limit: int = 1200) -> str:
    """The text to type when UiAutomator does the typing, not the shell.

    Quotes, apostrophes and dashes survive, because they are what makes a
    comment read like a person: `DM me "price script"` keeps its quotes. Only
    newlines are flattened, because one would post half a comment.
    """
    return _trim(re.sub(r"\s+", " ", _tidy(text)).strip(), limit)


def input_text_arg(text: str) -> str:
    """`input text` wants spaces as %s."""
    return sanitize(text).replace(" ", "%s")


def looks_published(nodes: list[Node], text: str) -> bool:
    """Did the comment appear? Compare on a distinctive slice of it."""
    needle = re.sub(r"\W+", " ", sanitize(text)).casefold().strip()
    if not needle:
        return False
    for node in nodes:
        haystack = re.sub(r"\W+", " ", node.label).casefold()
        if needle[:40] and needle[:40] in haystack:
            return True
        if needle[-40:] and len(needle) > 60 and needle[-40:] in haystack:
            return True
    return False


def composer_closed(before: list[Node], after: list[Node]) -> bool:
    """A reliable signal that the composer went away after submitting."""
    return composer(before) is not None and composer(after) is None


# ── persistence ──────────────────────────────────────────────────────────────

NS_GROUPS = "fb-groups"
NS_ENGAGE = "fb-engage"


@dataclass
class GroupRecord:
    """One group we found, joined, or refused, with the search that found it."""

    name: str
    url: str = ""
    state: str = "candidate"  # candidate | joined | requested | refused | failed
    score: int = 0
    kind: str = ""
    members: int = 0
    privacy: str = ""
    found_by: str = ""
    covers: int = 0  # addresses whose place this search covered
    country: str = ""
    joined_at: float = 0.0
    last_visit: float = 0.0
    note: str = ""
    reasons: list[str] = field(default_factory=list)


class GroupStore:
    """The group registry and the engagement state, in the existing cache.

    One JSON document per namespace keeps the phone driver free of database
    concerns, and makes a rebuild of a decision as simple as reading a dict.
    """

    TTL = 365 * 86400

    def __init__(self, cache) -> None:
        self.cache = cache
        self._groups: dict[str, GroupRecord] = {}
        self._searched: dict[str, dict] = {}
        raw = self.cache.get(NS_GROUPS, "registry") or {}
        for name, row in (raw.get("groups") or {}).items():
            self._groups[name] = GroupRecord(**row)
        self._searched = raw.get("searched") or {}
        self.engage = self.cache.get(NS_ENGAGE, "state") or {}

    # groups

    def all(self) -> list[GroupRecord]:
        return list(self._groups.values())

    def get(self, name: str) -> GroupRecord | None:
        return self._groups.get(name)

    def put(self, record: GroupRecord) -> None:
        self._groups[record.name] = record
        self._flush()

    def joined(self) -> list[GroupRecord]:
        return [g for g in self._groups.values() if g.state in ("joined", "requested")]

    def needs_visit(self, now: float | None = None, every_s: float = 6 * 3600) -> list[GroupRecord]:
        now = now if now is not None else time.time()
        return sorted((g for g in self.joined() if now - g.last_visit >= every_s),
                      key=lambda g: g.last_visit)

    # searches

    def searched(self, term: str) -> bool:
        return term in self._searched

    def mark_searched(self, term: str, found: int, kept: int) -> None:
        self._searched[term] = {"at": time.time(), "found": found, "kept": kept}
        self._flush()

    def search_count(self) -> int:
        return len(self._searched)

    def _flush(self) -> None:
        self.cache.set(NS_GROUPS, "registry", {
            "groups": {name: asdict(record) for name, record in self._groups.items()},
            "searched": self._searched,
        }, self.TTL)

    # engagement state

    def state(self) -> dict:
        self.engage = self.cache.get(NS_ENGAGE, "state") or self.engage or {}
        for key in ("commented_posts", "replied_comments", "liked_posts", "followed_authors",
                    "dm_sent", "cta_used_posts"):
            self.engage.setdefault(key, [])
        for key in ("author_last_comment", "author_first_seen", "author_touches"):
            self.engage.setdefault(key, {})
        return self.engage

    def save_state(self) -> None:
        self.cache.set(NS_ENGAGE, "state", self.engage, self.TTL)

    def review(self, item: dict) -> None:
        """Anything a human should see before it is posted, or after it failed."""
        queue = self.cache.get(NS_ENGAGE, "review") or []
        queue.append({**item, "at": time.time()})
        self.cache.set(NS_ENGAGE, "review", queue[-400:], self.TTL)

    def review_queue(self) -> list[dict]:
        return list(self.cache.get(NS_ENGAGE, "review") or [])


# ── the driver ───────────────────────────────────────────────────────────────


@dataclass
class GroupVisit:
    """What one pass over a group's feed did."""

    group: str
    posts_seen: int = 0
    likes: int = 0
    comments: int = 0
    replies: int = 0
    follows: int = 0
    skipped: int = 0
    blocked: str = ""
    notes: list[str] = field(default_factory=list)


class FacebookGroups:
    """Group discovery and engagement, driven through a `Galaxy`.

    The Galaxy owns the phone: its lock, its challenge handling, its retried
    reads and never-retried inputs, its geometry. This class only knows what a
    Facebook group looks like and what the rules allow, so a bug here cannot
    leave the phone in a state the rest of the worker cannot recover from.
    """

    def __init__(self, phone: "Galaxy", store: GroupStore, limits=None,
                 session=None, prompts=None) -> None:
        from .fb_engage import fb_limits

        self.phone = phone
        self.store = store
        self.limits = limits or fb_limits()
        self._session = session
        self._prompts = prompts  # a callable(CommentRequest) -> Generation, injectable

    # ── plumbing ─────────────────────────────────────────────────────────────

    async def _screen(self) -> list[Node]:
        return await self.phone._screen()

    async def _open(self, url: str, package: str = FACEBOOK) -> None:
        quoted = url.replace("'", "%27")
        await self.phone._input(
            f"am start -a android.intent.action.VIEW -d '{quoted}' -p {package}")

    async def _settle(self, seconds: float) -> None:
        """Wait in a way that yields to a lookup that wants the phone."""
        await self.phone._wait(seconds)

    async def _guard(self) -> str:
        """'' when it is safe to act, else why not (and pause what must pause)."""
        nodes = await self._screen()
        kind = challenge_kind(nodes)
        if kind == "challenge":
            self.phone._pause("facebook", "a security checkpoint")
            if self.limits.stop_on_challenge:
                self.phone._stop_everything("a security checkpoint")
            return "a security checkpoint needs you on the phone"
        if kind == "login":
            self.phone._pause("facebook", "a login screen")
            return "Facebook is signed out on the phone"
        return ""

    async def _reserve(self, action: str) -> tuple[bool, str]:
        """Book one unit of an action against both counters, or refuse.

        The counters live in the shared cache, so two processes, a restarted
        worker and a probe script all spend from the same daily allowance.
        """
        from .fb_engage import can_act, reserve_name

        day_name, hour_name = reserve_name(action)
        counts = {action: self.phone.cache.count(day_name), hour_name:
                  self.phone.cache.count(hour_name)}
        allowed, why = can_act(self.limits, self._session, action, counts)
        if not allowed:
            return False, why
        if not self.phone.cache.reserve(day_name, self.limits.cap(action, per_day=True)):
            return False, f"daily {action} cap reached"
        if not self.phone.cache.reserve(hour_name, self.limits.cap(action, per_day=False)):
            return False, f"hourly {action} cap reached"
        return True, ""

    async def _turn(self, app: str = "facebook") -> str:
        """None-equivalent '' when the phone may be used now, else why not."""
        if self.phone.phone_paused_for():
            return "the phone is paused after a security check"
        if self.phone.paused_for(app):
            return "the Facebook app is paused"
        if not await self.phone.available():
            return "the phone is unavailable"
        return await self._guard()

    # ── discovery ────────────────────────────────────────────────────────────

    async def search(self, term: SearchTerm) -> list[GroupCandidate]:
        """Run one search phrase and return the groups it shows."""
        why = await self._turn()
        if why:
            log.info("Facebook search skipped (%s): %s", term.term, why)
            return []
        allowed, why = await self._reserve("search")
        if not allowed:
            log.info("Facebook search skipped (%s): %s", term.term, why)
            return []
        async with self.phone._lock:
            if not await self.phone._hold_phone(wait_s=10):
                return []
            try:
                await self._open(SEARCH_URL.format(query=term.term.replace(" ", "%20")))
                await self._settle(SEARCH_SETTLE_S)
                found: list[GroupCandidate] = []
                seen: set[str] = set()
                for _ in range(MAX_SEARCH_SCROLLS):
                    blocked = await self._guard()
                    if blocked:
                        log.info("Facebook search stopped: %s", blocked)
                        break
                    for candidate in group_rows(await self._screen()):
                        if candidate.name.casefold() in seen:
                            continue
                        seen.add(candidate.name.casefold())
                        scored = score_group(candidate.name, term, candidate.members)
                        scored.url = candidate.url
                        scored.privacy = candidate.privacy
                        scored.found_by = term.term
                        found.append(scored)
                    if not found:
                        break
                    width, height = await self.phone._geometry()
                    await self.phone._swipe(_feed_swipe(width, height))
                    await self._settle(random.uniform(2.0, 4.0))
                kept = [c for c in found if keep(c)]
                self.store.mark_searched(term_key(term.term, term.country),
                                         len(found), len(kept))
                log.info("Search %r: %d result(s), %d worth joining",
                         term.term, len(found), len(kept))
                return found
            except PhoneUnavailable as err:
                log.info("Facebook search failed: %s", err)
                return []
            finally:
                self.phone._release_phone()

    def queue_searches(self, plan: dict, limit: int | None = None,
                       tiers: tuple[int, ...] = (1, 2, 3)) -> list[dict]:
        """The next searches to run: tier order, then density, never repeated.

        Ordered here rather than trusted from the file, so a plan written by an
        older version or edited by hand still runs the cheap, high-yield
        searches first.
        """
        terms = sorted((t for t in plan.get("terms", []) if t["tier"] in tiers),
                       key=lambda t: (t["tier"], -t.get("covers", 0), t["term"]))
        if limit is not None:
            # Top `limit` per tier, so a capped run still covers every tier.
            picked: list[dict] = []
            for tier in tiers:
                picked += [t for t in terms if t["tier"] == tier][:limit]
            terms = picked
        return [t for t in terms
                if not self.store.searched(term_key(t["term"], t.get("country", "")))]

    async def join(self, candidate: GroupCandidate, country: str = "",
                   covers: int = 0) -> GroupRecord:
        """Open the group and press Join. Records what the screen says afterwards."""
        record = self.store.get(candidate.name) or GroupRecord(
            name=candidate.name, url=candidate.url, score=candidate.score,
            kind=candidate.kind, members=candidate.members, privacy=candidate.privacy,
            found_by=candidate.found_by, covers=covers, country=country)
        why = await self._turn()
        if why:
            record.note = why
            return record
        allowed, why = await self._reserve("join")
        if not allowed:
            record.note = why
            return record
        async with self.phone._lock:
            if not await self.phone._hold_phone(wait_s=10):
                return record
            try:
                url = candidate.url or await self._resolve_group_url(candidate.name)
                if not url:
                    record.state, record.note = "failed", "no group URL on the result"
                    return record
                record.url = url
                await self._open(url)
                await self._settle(PAGE_SETTLE_S)
                blocked = await self._guard()
                if blocked:
                    record.note = blocked
                    return record
                nodes = await self._screen()
                button, state = join_control(nodes)
                if state == "joinable" and button is not None:
                    await self.phone._tap(button)
                    await self._settle(2.5)
                    after = await self._screen()
                    _, now_state = join_control(after)
                    if now_state in JOINED_LABELS:
                        record.state = "requested" if "request" in now_state else "joined"
                        record.joined_at = time.time()
                        record.note = f"screen says {now_state}"
                        log.info("Joined %s (%s)", candidate.name, now_state)
                    else:
                        record.state = "failed"
                        record.note = "Join tapped but the state did not change"
                elif state in JOINED_LABELS:
                    record.state = "requested" if "request" in state else "joined"
                    record.note = f"already {state}"
                else:
                    record.state, record.note = "refused", "no Join control on the group page"
                return record
            except PhoneUnavailable as err:
                record.state, record.note = "failed", str(err)
                return record
            finally:
                self.store.put(record)
                self.phone._release_phone()

    async def _resolve_group_url(self, name: str) -> str:
        """Search for the exact name and take the matching group's URL."""
        await self._open(SEARCH_URL.format(query=name.replace(" ", "%20")))
        await self._settle(SEARCH_SETTLE_S)
        for _ in range(2):
            for candidate in group_rows(await self._screen()):
                if candidate.url and candidate.name.casefold() == name.casefold():
                    return candidate.url
            await self.phone._swipe(_feed_swipe(*await self.phone._geometry()))
            await self._settle(2.0)
        return ""

    # ── the feed ─────────────────────────────────────────────────────────────

    async def visit(self, group: GroupRecord, per_group: int = 6) -> GroupVisit:
        """One pass over a group's feed: like, comment, reply, follow.

        Every action goes through `fb_engage.plan_post`, the caps, and the
        prompt gate. A post that fails any of them is skipped and counted, never
        posted as-is.
        """
        from .fb_engage import EngagementState, GroupSession, plan_post, read_post

        visit = GroupVisit(group=group.name)
        why = await self._turn()
        if why:
            visit.blocked = why
            return visit
        state = _engagement_state(self.store)
        session = self._session or GroupSession(self.limits)
        self._session = session
        async with self.phone._lock:
            if not await self.phone._hold_phone(wait_s=10):
                visit.blocked = "busy (another process is using the phone)"
                return visit
            try:
                await self._open(group.url or GROUP_URL.format(group=group.name))
                await self._settle(PAGE_SETTLE_S)
                visit.blocked = await self._guard()
                if visit.blocked:
                    return visit
                handled = 0
                for _ in range(per_group):
                    if visit.blocked or session.finished:
                        break
                    posts = post_rows(await self._screen())
                    if not posts:
                        visit.notes.append("no posts on screen")
                        break
                    author, text = posts[0]
                    post = read_post(text, author=author, group=group.name,
                                     url=f"{group.url}#{abs(hash(text)) % 10**8}")
                    decision = plan_post(post, session, state, self.limits)
                    if decision.skip:
                        visit.skipped += 1
                        if post.kind in ("sensitive", "promo", "hiring"):
                            self.store.review({"kind": "skipped-post", "group": group.name,
                                               "author": author, "text": text[:400],
                                               "why": decision.reason})
                        await self._next_post()
                        continue
                    if "like" in decision.actions and await self._like():
                        visit.likes += 1
                        state.liked_posts.add(post.url)
                        state.touch(author, text)
                    if decision.comment and await self._comment(group, post, decision.cta):
                        visit.comments += 1
                        state.commented_posts.add(post.url)
                        state.author_last_comment[author] = time.time()
                        state.touch(author, text)
                    if "reply" in decision.actions:
                        replied = await self._reply_thread(group, post, decision.reply_to[:2])
                        visit.replies += replied
                        if replied:
                            state.touch(author, text)
                    if "follow" in decision.actions and await self._follow(author):
                        visit.follows += 1
                        state.followed_authors.add(author)
                    handled += 1
                    group.last_visit = time.time()
                    await self._next_post()
                if not handled:
                    visit.notes.append("nothing engaged on this pass")
                return visit
            except PhoneUnavailable as err:
                visit.blocked = str(err)
                return visit
            finally:
                _save_engagement_state(self.store, state)
                self.store.put(group)
                self.phone._release_phone()

    async def _next_post(self) -> None:
        width, height = await self.phone._geometry()
        await self.phone._swipe(_feed_swipe(width, height))
        await self._settle(random.uniform(1.5, 3.5))

    async def _like(self) -> bool:
        allowed, why = await self._reserve("like")
        if not allowed:
            log.info("Like skipped: %s", why)
            return False
        nodes = await self._screen()
        for node in nodes:
            label = node.label.casefold().strip()
            if label in LIKE_LABELS and node.clickable and label != "remove like":
                await self.phone._tap(node)
                await self._settle(1.2)
                after = await self._screen()
                if any(n.label.casefold().strip() in ("remove like", "unlike")
                       or (n.rid == node.rid and n.selected) for n in after):
                    return True
                log.info("the like did not register")
                return False
        return False

    async def _comment(self, group: GroupRecord, post, cta: bool) -> bool:
        """Draft, gate, type and verify one comment."""
        allowed, why = await self._reserve("comment")
        if not allowed:
            log.info("Comment skipped: %s", why)
            return False
        text = await self._draft(group, post, cta=cta, thread_comment="")
        if not text:
            return False
        if not await self._type_and_submit(text, post.url):
            return False
        state = _engagement_state(self.store)
        state.remember_comment(post.url, text)
        if cta:
            state.cta_used_posts.add(post.url)
        _save_engagement_state(self.store, state)
        return True

    async def _reply_thread(self, group: GroupRecord, post, targets: list[str]) -> int:
        """Answer up to two other commenters under one question post.

        Each reply answers something a specific person wrote, which is why the
        comment text is read off the screen rather than paraphrased from the
        post: a reply that ignores the comment it sits under is worse than none.
        """
        made = 0
        nodes = await self._screen()
        threads = [row for row in comment_rows(nodes) if row[1]]
        state = _engagement_state(self.store)
        for target, (author, text) in zip(targets, threads):
            allowed, why = await self._reserve("reply")
            if not allowed:
                log.info("Reply skipped: %s", why)
                break
            draft = await self._draft(group, post, cta=False, thread_comment=text)
            if not draft:
                continue
            if await self._type_and_submit(draft, target, reply_to=author):
                made += 1
                state.replied_comments.add(target)
                state.replies_by_post[post.url] = state.replies_by_post.get(post.url, 0) + 1
                state.remember_comment(post.url, draft)
                _save_engagement_state(self.store, state)
        return made

    async def _draft(self, group: GroupRecord, post, cta: bool, thread_comment: str) -> str:
        """Ask the prompt layer for a comment; refuse anything that fails the gate."""
        from .fb_prompts import CommentRequest, check

        if self._prompts is None:
            log.info("No prompt client is attached; comment skipped")
            return ""
        state = _engagement_state(self.store)
        request = CommentRequest(
            post_text=post.text,
            market="UK" if group.country == "UK" else "US",
            group_name=group.name, group_kind=group.kind or "owners",
            author_role=post.author_kind, thread_comment=thread_comment,
            cta_available=cta and post.url not in state.cta_used_posts,
            prior_comments=state.prior_for(post.url),
        )
        try:
            generation = self._prompts(request)
        except Exception as err:  # noqa: BLE001 - a failed draft must not stop the pass
            log.info("Draft failed: %s", err)
            self.store.review({"kind": "draft-error", "group": group.name,
                               "text": post.text[:400], "why": str(err)})
            return ""
        reply = generation.reply
        if reply is None or reply.action != "comment":
            why = generation.error or (reply.skip_reason if reply else "")
            self.store.review({"kind": "no-comment", "group": group.name,
                               "text": post.text[:400], "why": why})
            return ""
        problems = check(reply, request)
        if problems:
            log.info("Draft failed the gate: %s", "; ".join(problems[:3]))
            self.store.review({"kind": "gate-failed", "group": group.name,
                               "text": post.text[:300], "comment": reply.comment,
                               "why": "; ".join(problems)})
            return ""
        return reply.comment

    async def _enter_text(self, text: str) -> bool:
        """Type into the focused field: UiAutomator if it can, adb shell if not.

        `adb shell input text` is a shell command, so it loses quotes and every
        character that could redirect it: `DM me "price script"` arrives as
        `DM me price script`. UiAutomator's `set_text` has no such problem and the
        Galaxy already holds that connection for its screen reads, so the comment
        reaches Facebook exactly as the model wrote it. The shell path stays as
        the fallback, with the stricter sanitizer.
        """
        ui = getattr(self.phone, "_ui", None)
        if ui is not None:
            try:
                await asyncio.to_thread(lambda: ui(focused=True).set_text(text))
                log.info("Typed %d characters with UiAutomator", len(text))
                return True
            except Exception as err:  # noqa: BLE001 - fall back; never fail the pass
                log.info("UiAutomator typing failed (%s); using adb input text", err)
        await self.phone._input(f"input text {input_text_arg(text)}")
        log.info("Typed %d characters with adb input text", len(text))
        return True

    async def _type_and_submit(self, text: str, key: str, reply_to: str = "") -> bool:
        """Tap Comment (or the Reply under `reply_to`), type, submit, verify.

        This is the only place Facebook is ever given text, and it is the only
        place that must never guess: no composer, no post; no submit control, a
        Back and nothing sent.
        """
        nodes = await self._screen()
        if reply_to:
            thread = next((row for row in comment_rows(nodes)
                           if row[0].casefold() == reply_to.casefold()), None)
            button = thread[2] if thread else None
        else:
            button = next(iter(comment_controls(nodes)), None)
        if button is None:
            log.info("No Comment/Reply control for %r", key)
            return False
        await self.phone._tap(button)
        await self._settle(1.5)
        for _ in range(int(COMPOSER_WAIT_S / 0.5)):
            nodes = await self._screen()
            if composer(nodes) is not None:
                break
            await self._settle(0.5)
        else:
            log.info("The comment composer did not open")
            return False
        field_node = composer(nodes)
        if field_node is not None:
            await self.phone._tap(field_node)
            await self._settle(0.6)
        safe = clean_text(text)
        if len(safe.split()) < 20:
            log.info("Comment too short to post (%d words); refused", len(safe.split()))
            return False
        await self._enter_text(safe)
        await self._settle(1.0)
        nodes = await self._screen()
        submit = submit_control(nodes)
        if submit is None:
            log.info("No Post/Send control in the composer")
            await self.phone._key("KEYCODE_BACK")
            return False
        await self.phone._tap(submit)
        await self._settle(2.5)
        after = await self._screen()
        if looks_published(after, safe) or composer_closed(nodes, after):
            log.info("Comment posted and verified (%d words)", len(safe.split()))
            return True
        log.info("The comment did not appear to post")
        return False

    async def _follow(self, author: str) -> bool:
        """Follow an author from their profile page, and verify the state."""
        allowed, why = await self._reserve("follow")
        if not allowed:
            log.info("Follow skipped: %s", why)
            return False
        if not author:
            return False
        await self._open(f"https://www.facebook.com/search/people/?q={author.replace(' ', '%20')}")
        await self._settle(SEARCH_SETTLE_S)
        nodes = await self._screen()
        match = next((n for n in nodes if n.clickable
                      and n.label.casefold().strip() == author.casefold().strip()), None)
        if match is None:
            return False
        await self.phone._tap(match)
        await self._settle(PAGE_SETTLE_S)
        nodes = await self._screen()
        follow = find_button(nodes, *FOLLOW_LABELS)
        if follow is None:
            return False
        await self.phone._tap(follow)
        await self._settle(1.5)
        after = await self._screen()
        if any(n.label.casefold().strip() in FOLLOWING_LABELS for n in after):
            log.info("Following %s", author)
            return True
        return False

    # ── daily outreach ───────────────────────────────────────────────────────

    async def outreach(self, group: GroupRecord, max_dms: int = 3) -> list[tuple[str, str]]:
        """DM owners the account has already engaged with, one message each.

        Only people with real history are eligible (`fb_engage.dm_eligible`);
        the opener quotes something they wrote, so it cannot read as a blast.
        """
        from .fb_engage import dm_eligible

        sent: list[tuple[str, str]] = []
        state = _engagement_state(self.store)
        candidates = sorted(state.author_touches.items(), key=lambda kv: -kv[1])
        for author, _ in candidates:
            if len(sent) >= max_dms:
                break
            ok, why = dm_eligible(author, state, self.limits)
            if not ok:
                log.debug("No DM for %s: %s", author, why)
                continue
            allowed, why = await self._reserve("dm")
            if not allowed:
                break
            line = await self._dm_text(group, author)
            if not line:
                continue
            if await self._send_dm(author, line):
                state.dm_sent.add(author)
                sent.append((author, line))
                _save_engagement_state(self.store, state)
        return sent

    async def _dm_text(self, group: GroupRecord, author: str) -> str:
        """The opener: their own words, then the thing they asked for.

        A DM that could have been sent to anybody is a blast, and a blast from a
        new account is how a group membership ends.
        """
        from .fb_engage import dm_line

        state = _engagement_state(self.store)
        their_words = state.author_last_text.get(author, "")
        keyword = next(iter([k for k in ("ringout", "price script", "show-up", "math",
                                         "third ring", "questions", "january")
                             if k in their_words.casefold()]), "")
        return dm_line(their_words or f"you posted in {group.name}", keyword)

    async def _send_dm(self, author: str, text: str) -> bool:
        """Open Messenger, find the thread, send, verify."""
        await self._open(MESSAGES_URL, MESSENGER)
        await self._settle(PAGE_SETTLE_S)
        nodes = await self._screen()
        thread = next((n for n in nodes if n.clickable
                       and author.casefold() in n.label.casefold()), None)
        if thread is None:
            return False
        await self.phone._tap(thread)
        await self._settle(1.5)
        nodes = await self._screen()
        field_node = next((n for n in nodes if n.package.startswith(MESSENGER)
                           and "edit_text" in n.rid.casefold()), None)
        if field_node is None:
            return False
        await self.phone._tap(field_node)
        await self.phone._input(f"input text {input_text_arg(sanitize(text))}")
        await self._settle(0.8)
        send = next((n for n in await self._screen()
                     if n.label.casefold().strip() == "send" and n.clickable), None)
        if send is None:
            return False
        await self.phone._tap(send)
        await self._settle(2.0)
        return looks_published(await self._screen(), text)


def _feed_swipe(width: int, height: int) -> "Gesture":
    from .ambient import Gesture

    span = random.uniform(0.45, 0.72) * height
    x1 = int(random.uniform(0.2, 0.75) * width)
    y1 = int(random.uniform(0.62, 0.86) * height)
    return Gesture(x1, y1, x1 + random.randint(-8, 8),
                   int(min(max(y1 - span, 0.14 * height), 0.94 * height)),
                   random.randint(180, 420), "feed")


def _engagement_state(store: GroupStore):
    from .fb_engage import EngagementState

    raw = store.state()
    return EngagementState(
        commented_posts=set(raw.get("commented_posts") or []),
        replied_comments=set(raw.get("replied_comments") or []),
        liked_posts=set(raw.get("liked_posts") or []),
        followed_authors=set(raw.get("followed_authors") or []),
        dm_sent=set(raw.get("dm_sent") or []),
        cta_used_posts=set(raw.get("cta_used_posts") or []),
        author_last_comment=dict(raw.get("author_last_comment") or {}),
        author_first_seen=dict(raw.get("author_first_seen") or {}),
        author_touches=dict(raw.get("author_touches") or {}),
        comment_texts={k: list(v) for k, v in (raw.get("comment_texts") or {}).items()},
        replies_by_post=dict(raw.get("replies_by_post") or {}),
        author_last_text=dict(raw.get("author_last_text") or {}),
    )


def _save_engagement_state(store: GroupStore, state) -> None:
    store.engage = {
        "commented_posts": sorted(state.commented_posts),
        "replied_comments": sorted(state.replied_comments),
        "liked_posts": sorted(state.liked_posts),
        "followed_authors": sorted(state.followed_authors),
        "dm_sent": sorted(state.dm_sent),
        "cta_used_posts": sorted(state.cta_used_posts),
        "author_last_comment": state.author_last_comment,
        "author_first_seen": state.author_first_seen,
        "author_touches": state.author_touches,
        "comment_texts": {k: list(v)[-6:] for k, v in state.comment_texts.items()},
        "replies_by_post": state.replies_by_post,
        "author_last_text": state.author_last_text,
    }
    store.save_state()
