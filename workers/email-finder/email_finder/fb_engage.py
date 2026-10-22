"""What the group session decides to do, and what it refuses to do.

This is the Facebook-groups counterpart of `ambient.py`: pure decisions in,
decisions out, seeded so a test can pin the stream exactly. Nothing here touches
the phone.

The differences from the Instagram session are the point of the module:

* **Comments are the expensive action.** A like is cheap and reversible; a
  comment is public, permanent and attached to the account's name. Comments get
  the tightest caps in the file, they are spaced by minutes rather than
  seconds, and they are gated on the post being worth one.
* **One comment per post, up to three replies.** Replies under other people's
  comments are allowed — that is where a conversation actually happens — but
  each reply goes to a different person, and the whole post gets one call to
  action, not one per reply.
* **A follow is earned, not sprayed.** The session follows the author of a post
  it engaged with, not every author it scrolled past.
* **A DM needs history.** Daily outreach only messages people the session has
  already engaged with, after a waiting period, and never twice.
* **Sensitive posts are off limits.** Grief, politics, pile-ons, safeguarding,
  legal and medical questions go to a human queue instead of a comment
  generator. A comment on the wrong post costs more than a week of posting on
  the right ones.

Every cap is env-tunable (`FB_GROUPS_*`), because the caps — not the
randomness — are what actually bounds the account's exposure.
"""

from __future__ import annotations

import math
import os
import random
import re
import time
from dataclasses import dataclass, field

from .ambient import Gesture, hour_bucket, in_quiet_hours

# ── default caps ─────────────────────────────────────────────────────────────
# Per hour / per day. A human owner in a group they care about is nowhere near
# these; the numbers are set for the fastest pace that can still be explained.
CAPS: dict[str, tuple[int, int]] = {
    "like": (40, 200),
    "comment": (5, 18),
    "reply": (8, 28),
    "follow": (5, 25),
    "dm": (6, 20),
    "join": (3, 12),
    "search": (12, 60),
}

# Minimum seconds between two actions of the same kind, drawn per action.
COOLDOWN: dict[str, tuple[float, float]] = {
    "like": (35.0, 150.0),
    "comment": (240.0, 900.0),
    "reply": (150.0, 480.0),
    "follow": (300.0, 900.0),
    "dm": (420.0, 1200.0),
    "join": (600.0, 1800.0),
}
# How often the session does each thing when it is otherwise free to. Comments
# and DMs sit far below likes on purpose: that is the shape of a real account.
ACTION_BASE = {"like": 0.22, "comment": 0.05, "reply": 0.06, "follow": 0.04,
               "dm": 0.01, "join": 0.02}
MOOD_BETA = (2.2, 5.5)  # most sessions are calm
FATIGUE = 0.15  # per ten posts, how fast a session settles down
DWELL_MEDIAN, DWELL_SIGMA = 8.0, 0.8  # seconds spent on a post
LONG_READ_ODDS, LONG_READ = 0.10, (35.0, 120.0)
SESSION_POSTS_MEDIAN, SESSION_POSTS_SIGMA = 11.0, 0.6
SESSION_POSTS_MAX = 70
SLICE_POSTS = (2, 5)  # posts per phone slice, so other work gets a turn
REST_SHORT = (25.0, 120.0)  # seconds between slices: a feed is not scrolled fast

# Limits on structure, not on pace.
MAX_REPLIES_PER_POST = 3
MAX_COMMENTS_PER_POST = 1
PER_AUTHOR_COOLDOWN_DAYS = 7  # days before commenting again on the same person
DM_AFTER_ENGAGEMENT_DAYS = 3  # wait this long between first engagement and a DM
DM_NEVER_AFTER_REPLY_DAYS = 1  # don't pitch someone we replied to yesterday
WARMUP_DAYS = 14  # a new account runs at 40% then 70% of the caps
QUIET_HOURS = (1, 6)  # local wall clock
CAP_HOURS_ON_CHALLENGE = 12

# ── post classification ──────────────────────────────────────────────────────
QUESTION_STARTS = ("how do", "how can", "what do", "what's the", "whats the", "does anyone",
                   "anyone else", "any advice", "anyone know", "which", "should i",
                   "worth it", "is it worth", "help", "looking for", "recommend")
PAIN_WORDS = ("struggl", "losing", "lost", "no one", "nobody", "nobody's", "missed call",
              "missed", "slow", "quiet", "cancell", "churn", "expensive", "burn", "tired",
              "exhaust", "overwhelm", "behind", "behind on", "can't afford", "cant afford",
              "not converting", "converting", "ghost", "no shows", "no-shows", "down",
              "dropped", "bleeding", "wasting", "waste", "nightmare", "problem", "issue")
WIN_WORDS = ("we just", "proud", "excited", "milestone", "opened", "celebrating",
             "first class", "thank you", "grateful", "new belt", "promotion", "got our",
             "we hit", "record", "sold out", "full class")
PROMO_WORDS = ("dm me", "message me", "book now", "sign up", "offer", "discount", "promo",
               "limited", "free trial", "link in bio", "click", "shop", "sale", "webinar",
               "register", "spots left", "join my", "masterclass", "course")
SENSITIVE_WORDS = ("passed away", "died", "death", "funeral", "bereave", "condolence",
                   "diagnos", "cancer", "hospital", "surgery", "safeguarding", "abuse",
                   "assault", "police", "court", "lawsuit", "sued", "immigration", "visa",
                   "tax", "hmrc", "irs", "divorce", "custody", "suicide", "mental health",
                   "election", "trump", "biden", "brexit", "war ", "genocide")
PILEON_WORDS = ("scam", "fraud", "rip off", "ripoff", "exposed", "beware", "warning about",
                "avoid this", "stay away from")
HIRING_WORDS = ("hiring", "looking for a coach", "job", "vacancy", "apply", "position")
OFFER_WORDS = ("we offer", "our services", "our company", "we provide", "we help schools",
               "we specialize", "our agency")
OWNER_WORDS = ("my school", "our school", "my dojo", "my gym", "students", "members",
               "class", "curriculum", "staff", "front desk", "trial", "intro offer",
               "contract", "tuition", "mat")
ADULT_WORDS = ("bjj", "mma", "muay thai", "boxing", "adult", "open mat", "no-gi", "nogii")


def _flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in ("off", "0", "no", "false", "")


def _num(name: str, default: float) -> float:
    try:
        return float(os.environ[name])
    except (KeyError, ValueError):
        return default


@dataclass
class FbLimits:
    """Whether the session runs at all, what it may do, and how often."""

    enabled: bool = True
    like: bool = True
    comment: bool = True
    reply: bool = True
    follow: bool = True
    dm: bool = True
    join: bool = True
    search: bool = True
    caps: dict[str, tuple[int, int]] = field(default_factory=lambda: dict(CAPS))
    quiet_hours: tuple[int, int] | None = QUIET_HOURS
    warmup_days: int = WARMUP_DAYS
    account_age_days: int = 90
    max_replies_per_post: int = MAX_REPLIES_PER_POST
    max_comments_per_post: int = MAX_COMMENTS_PER_POST
    per_author_cooldown_days: int = PER_AUTHOR_COOLDOWN_DAYS
    dm_after_engagement_days: int = DM_AFTER_ENGAGEMENT_DAYS
    stop_on_challenge: bool = True
    cap_hours: int = CAP_HOURS_ON_CHALLENGE
    min_comment_chars: int = 60  # a post shorter than this is not worth a comment

    def warmup_factor(self) -> float:
        """A young account does less. Nothing raises the caps: only time does."""
        if self.account_age_days >= self.warmup_days:
            return 1.0
        if self.account_age_days >= self.warmup_days / 2:
            return 0.7
        return 0.4

    def cap(self, action: str, per_day: bool = True) -> int:
        hour, day = self.caps.get(action, (0, 0))
        return int((day if per_day else hour) * self.warmup_factor())


def fb_limits() -> FbLimits:
    caps = {name: (int(_num(f"FB_GROUPS_{name.upper()}_PER_HOUR", hour)),
                   int(_num(f"FB_GROUPS_{name.upper()}_PER_DAY", day)))
            for name, (hour, day) in CAPS.items()}
    raw_quiet = os.environ.get("FB_GROUPS_QUIET_HOURS")
    quiet: tuple[int, int] | None = QUIET_HOURS
    if raw_quiet is not None:
        if raw_quiet.strip().lower() in ("off", "0", "no", "none", ""):
            quiet = None
        else:
            start, _, end = raw_quiet.partition("-")
            try:
                quiet = (int(start), int(end))
            except ValueError:
                quiet = QUIET_HOURS
    return FbLimits(
        enabled=_flag("FB_GROUPS_ENGAGE", True),
        like=_flag("FB_GROUPS_LIKE", True),
        comment=_flag("FB_GROUPS_COMMENT", True),
        reply=_flag("FB_GROUPS_REPLY", True),
        follow=_flag("FB_GROUPS_FOLLOW", True),
        dm=_flag("FB_GROUPS_DM", True),
        join=_flag("FB_GROUPS_JOIN", True),
        search=_flag("FB_GROUPS_SEARCH", True),
        caps=caps,
        quiet_hours=quiet,
        account_age_days=int(_num("FB_GROUPS_ACCOUNT_AGE_DAYS", 90)),
        max_replies_per_post=int(_num("FB_GROUPS_MAX_REPLIES_PER_POST", MAX_REPLIES_PER_POST)),
        per_author_cooldown_days=int(_num("FB_GROUPS_AUTHOR_COOLDOWN_DAYS",
                                         PER_AUTHOR_COOLDOWN_DAYS)),
        dm_after_engagement_days=int(_num("FB_GROUPS_DM_AFTER_DAYS",
                                         DM_AFTER_ENGAGEMENT_DAYS)),
        min_comment_chars=int(_num("FB_GROUPS_MIN_COMMENT_CHARS", 60)),
        cap_hours=int(_num("FB_GROUPS_CHALLENGE_HOURS", CAP_HOURS_ON_CHALLENGE)),
    )


# ── what a post is ───────────────────────────────────────────────────────────


@dataclass
class Post:
    """One post (or comment) as the feed reader saw it."""

    text: str
    author: str = ""
    url: str = ""
    group: str = ""
    kind: str = "other"  # question | pain | win | promo | hiring | sensitive | social
    author_kind: str = "unknown"  # owner | instructor | parent | vendor | unknown
    likes: int = 0
    comments: int = 0
    is_ad: bool = False
    reasons: list[str] = field(default_factory=list)

    @property
    def chars(self) -> int:
        return len(self.text.strip())


def _list_regex(words: tuple[str, ...]) -> re.Pattern[str]:
    """Whole words only: "first" contains "irs", and a tax flag on a belt
    promotion is how a good post gets skipped for no reason."""
    parts = []
    for word in words:
        escaped = re.escape(word.strip())
        parts.append(escaped if " " in escaped else rf"{escaped}(?:s|es)?")
    return re.compile(r"\b(?:" + "|".join(parts) + r")\b", re.I)


_QUESTION_RE = re.compile(r"\b(?:" + "|".join(re.escape(s) for s in QUESTION_STARTS) + r")", re.I)
_PAIN = _list_regex(PAIN_WORDS)
_WIN = _list_regex(WIN_WORDS)
_PROMO = _list_regex(PROMO_WORDS)
_SENSITIVE = _list_regex(SENSITIVE_WORDS)
_PILEON = _list_regex(PILEON_WORDS)
_HIRING = _list_regex(HIRING_WORDS)
_OFFER = _list_regex(OFFER_WORDS)
_OWNER = _list_regex(OWNER_WORDS)


def classify(text: str) -> str:
    """The label the planner uses to decide whether a post deserves a comment.

    Order matters. Sensitive beats everything (never comment), then a pile-on,
    then an advert, then a question, then a pain statement, then a win, then
    ordinary social posting.
    """
    lowered = (text or "").casefold()
    if not lowered.strip():
        return "other"
    if _SENSITIVE.search(lowered) or _PILEON.search(lowered):
        return "sensitive"
    if _HIRING.search(lowered) and any(word in lowered for word in
                                       ("we are", "we're", "looking for", "apply")):
        return "hiring"
    if _OFFER.search(lowered) or _PROMO.search(lowered):
        return "promo"
    if "?" in text or _QUESTION_RE.match(lowered.strip()):
        return "question"
    if _PAIN.search(lowered):
        return "pain"
    if _WIN.search(lowered):
        return "win"
    return "social"


def author_kind(text: str, group_kind: str = "owners") -> str:
    """A guess at who is writing, from what they say about themselves.

    Only a guess: the planner uses it to decide *whether* to be careful, never to
    decide that someone is a buyer.
    """
    lowered = (text or "").casefold()
    if _OFFER.search(lowered):
        return "vendor"
    if group_kind in ("owners", "martial-arts") and _OWNER.search(lowered):
        return "owner"
    if any(word in lowered for word in ("my coach", "our coach", "my son", "my daughter",
                                        "my child", "as a parent")):
        return "parent"
    if any(word in lowered for word in ("students at my", "i teach", "my classes",
                                        "i instruct")):
        return "instructor"
    return "unknown"


def read_post(text: str, **extra) -> Post:
    """Classify a scraped post in one call, so the driver has nothing to decide."""
    kind = classify(text)
    post = Post(text=text, kind=kind, author_kind=author_kind(text, extra.pop("group_kind", "owners")),
                **extra)
    if kind == "sensitive":
        post.reasons.append("sensitive or pile-on: a human decides, not a comment generator")
    elif kind == "promo":
        post.reasons.append("someone else's advert: commenting there helps them, not us")
    elif kind == "hiring":
        post.reasons.append("a job post: a comment reads as prospecting")
    return post


# ── the session ──────────────────────────────────────────────────────────────


@dataclass
class EngagementState:
    """What we already did, as the driver persists it.

    Kept separate from the phone so the same state can be replayed in a test, and
    so a restart cannot re-comment a post it already commented.
    """

    commented_posts: set[str] = field(default_factory=set)
    replied_comments: set[str] = field(default_factory=set)
    liked_posts: set[str] = field(default_factory=set)
    followed_authors: set[str] = field(default_factory=set)
    dm_sent: set[str] = field(default_factory=set)
    cta_used_posts: set[str] = field(default_factory=set)
    author_last_comment: dict[str, float] = field(default_factory=dict)
    author_first_seen: dict[str, float] = field(default_factory=dict)
    author_touches: dict[str, int] = field(default_factory=dict)
    # The exact words we already published on a post, so a second reply in the
    # same thread cannot repeat a phrase (the prompt gate checks this).
    comment_texts: dict[str, list[str]] = field(default_factory=dict)
    # How many replies we have left on a post, and the last thing each person
    # wrote (a DM opener quotes it back, which is what stops it reading as a blast).
    replies_by_post: dict[str, int] = field(default_factory=dict)
    author_last_text: dict[str, str] = field(default_factory=dict)

    def touch(self, author: str, text: str = "", now: float | None = None) -> None:
        now = now if now is not None else time.time()
        self.author_touches[author] = self.author_touches.get(author, 0) + 1
        self.author_first_seen.setdefault(author, now)
        if text:
            self.author_last_text[author] = text[:400]

    def remember_comment(self, url: str, text: str) -> None:
        self.comment_texts.setdefault(url, []).append(text)

    def prior_for(self, url: str) -> list[str]:
        return list(self.comment_texts.get(url, []))


class GroupSession:
    """One stretch of scrolling a group: its mood, its pace and its decisions."""

    def __init__(self, limits: FbLimits, rng: random.Random | None = None,
                 clock=time.monotonic) -> None:
        self.limits = limits
        self._rng = rng or random.Random()
        self._clock = clock
        self.mood = self._rng.betavariate(*MOOD_BETA)
        self.posts = 0
        self.limit = self._session_length()
        self._next_allowed: dict[str, float] = {}
        self._did: dict[str, int] = {}

    def _session_length(self) -> int:
        drawn = self._rng.lognormvariate(math.log(SESSION_POSTS_MEDIAN), SESSION_POSTS_SIGMA)
        return int(min(SESSION_POSTS_MAX, max(4, drawn)))

    @property
    def finished(self) -> bool:
        return self.posts >= self.limit

    def slice_length(self) -> int:
        return self._rng.randint(*SLICE_POSTS)

    def rest(self) -> float:
        return self._rng.uniform(*REST_SHORT)

    def record(self, action: str) -> None:
        lo, hi = COOLDOWN.get(action, (0.0, 0.0))
        self._next_allowed[action] = self._clock() + self._rng.uniform(lo, hi)
        self._did[action] = self._did.get(action, 0) + 1

    def watched(self) -> None:
        self.posts += 1

    # ── the shapes of a session ──────────────────────────────────────────────

    def dwell(self) -> float:
        """Seconds on a post before acting. Reading is slower than Reels."""
        if self._rng.random() < LONG_READ_ODDS:
            return self._rng.uniform(*LONG_READ)
        drawn = self._rng.lognormvariate(math.log(DWELL_MEDIAN), DWELL_SIGMA)
        return min(120.0, max(2.0, drawn))

    def scroll(self, width: int, height: int) -> Gesture:
        """A downward swipe to the next post, clear of the nav bar and the rail."""
        span = self._rng.uniform(0.45, 0.72) * height
        duration = self._rng.randint(180, 420)
        x1 = int(self._rng.uniform(0.2, 0.75) * width)
        y1 = int(self._rng.uniform(0.62, 0.86) * height)
        y2 = int(min(max(y1 - span, 0.14 * height), 0.94 * height))
        x2 = x1 + int(max(-0.06, min(0.06, self._rng.gauss(0.0, 0.02))) * width)
        return Gesture(x1, y1, x2, y2, duration, "feed")

    def action(self, allowed: dict[str, bool] | None = None) -> str:
        """The action for the post just read: one of the caps' keys, or "none"."""
        allowed = allowed or {}
        mood = self.mood * math.exp(-FATIGUE * self.posts / 10.0)
        now = self._clock()
        weights: dict[str, float] = {}
        for name, base in ACTION_BASE.items():
            if not getattr(self.limits, name, True) or not allowed.get(name, True):
                continue
            if now < self._next_allowed.get(name, 0.0):
                continue
            weights[name] = base * (0.45 + mood)
        total = sum(weights.values())
        if total <= 0:
            return "none"
        roll = self._rng.random()
        if roll > min(1.0, total):
            return "none"
        seen = 0.0
        for name, weight in weights.items():
            seen += weight
            if roll <= seen:
                return name
        return "none"

    def describe(self) -> str:
        did = ", ".join(f"{n}={c}" for n, c in self._did.items() if c) or "nothing yet"
        return f"mood {self.mood:.2f}, post {self.posts}/{self.limit}, {did}"


# ── the rules ────────────────────────────────────────────────────────────────


@dataclass
class Decision:
    """What to do about one post, and why. The why is always recorded."""

    actions: list[str] = field(default_factory=list)
    comment: bool = False
    reply_to: list[str] = field(default_factory=list)  # comment ids/authors to answer
    cta: bool = False
    skip: bool = False
    reason: str = ""

    def explain(self) -> str:
        return self.reason or ("then ".join(self.actions) or "nothing")


def should_comment(post: Post, limits: FbLimits, state: EngagementState,
                   now: float | None = None) -> tuple[bool, str]:
    """Is this post worth a public comment?

    A comment is refused for seven reasons, in the order that costs least to
    check. Each refusal is a sentence the log can show a human.
    """
    if not limits.comment:
        return False, "comments are turned off"
    if post.url and post.url in state.commented_posts:
        return False, "already commented on this post"
    if post.is_ad:
        return False, "a sponsored post"
    if post.kind in ("sensitive", "promo", "hiring"):
        return False, f"a {post.kind} post"
    if post.chars < limits.min_comment_chars:
        return False, "too short to be worth a comment"
    if post.chars > 4000:
        return False, "too long to have read properly"
    if post.author_kind == "vendor":
        return False, "another vendor's post"
    if post.kind not in ("question", "pain"):
        return False, f"a {post.kind} post, not a question or a problem"
    if post.author and post.author in state.author_last_comment:
        last = state.author_last_comment[post.author]
        if (now or time.time()) - last < limits.per_author_cooldown_days * 86400:
            return False, "commented on this person recently"
    return True, ""


def plan_post(post: Post, session: GroupSession, state: EngagementState,
              limits: FbLimits | None = None, now: float | None = None) -> Decision:
    """Like, comment, and reply: the per-post plan, in the order it happens."""
    limits = limits or session.limits
    now = now if now is not None else time.time()
    decision = Decision()
    if post.is_ad:
        decision.skip, decision.reason = True, "sponsored post"
        return decision
    if post.kind in ("sensitive", "promo", "hiring"):
        decision.skip = True
        decision.reason = post.reasons[0] if post.reasons else f"a {post.kind} post"
        return decision

    if limits.like and post.url and post.url not in state.liked_posts:
        decision.actions.append("like")

    wanted, why = should_comment(post, limits, state, now)
    if wanted:
        decision.comment = True
        decision.actions.append("comment")
        if post.url and post.url not in state.cta_used_posts:
            decision.cta = True
    else:
        decision.reason = why

    # Replies to other people's comments: only under a post that is a genuine
    # question, only to people we have not answered here, and never more than
    # the post's allowance. The ids are the post plus the commenter's name, so a
    # restart cannot answer the same person twice.
    if limits.reply and post.kind == "question" and post.comments >= 1:
        used = state.replies_by_post.get(post.url, 0)
        allowance = max(0, limits.max_replies_per_post - used)
        if allowance:
            decision.reply_to = [f"{post.url or post.author}#{used + i}"
                                 for i in range(allowance)
                                 if f"{post.url or post.author}#{used + i}"
                                 not in state.replied_comments]
            if decision.reply_to:
                decision.actions.append("reply")

    if limits.follow and post.author and post.author not in state.followed_authors \
            and post.author_kind in ("owner", "instructor", "unknown") \
            and post.kind in ("question", "pain"):
        decision.actions.append("follow")

    if not decision.actions:
        decision.skip = True
        decision.reason = decision.reason or "nothing worth doing here"
    return decision


def dm_eligible(author: str, state: EngagementState, limits: FbLimits,
                now: float | None = None) -> tuple[bool, str]:
    """May we open a DM with this person today?

    The rule is history first: a DM is only allowed after the account has
    engaged with the person more than once, at least `dm_after_engagement_days`
    after the first touch, and never if they were replied to yesterday (that
    reads as pestering).
    """
    now = now if now is not None else time.time()
    if not limits.dm:
        return False, "DMs are turned off"
    if author in state.dm_sent:
        return False, "already messaged"
    touches = state.author_touches.get(author, 0)
    if touches < 2:
        return False, "no history: fewer than two interactions"
    first = state.author_first_seen.get(author)
    if first is None or now - first < limits.dm_after_engagement_days * 86400:
        return False, "engaged too recently to message"
    last_comment = state.author_last_comment.get(author)
    if last_comment and now - last_comment < DM_NEVER_AFTER_REPLY_DAYS * 86400:
        return False, "commented on them in the last day"
    return True, ""


def dm_line(post_text: str, keyword: str = "") -> str:
    """The first line of a DM, built from something they actually wrote.

    It exists so the opener is never generic: quoting their own words is the
    difference between a message and a broadcast.
    """
    quote = re.sub(r"\s+", " ", (post_text or "").strip())
    if len(quote) > 120:
        quote = quote[:117].rsplit(" ", 1)[0] + "..."
    lead = f'You wrote: "{quote}"' if quote else "You posted in the group about missed calls."
    tail = f" Here is the {keyword} I mentioned." if keyword else " Here is the thing I mentioned."
    return lead + tail


def can_act(limits: FbLimits, session: GroupSession, action: str,
            counts: dict[str, int] | None = None, now: float | None = None) -> tuple[bool, str]:
    """A single place where a cap, a cooldown and the clock are checked.

    `counts` holds the counters the driver has already reserved today
    (`{"like": 12, "like@2026-10-22T14": 3, ...}`); the driver's cache is the
    source of truth, this only refuses early.
    """
    if not getattr(limits, action, True):
        return False, f"{action} is turned off"
    if in_quiet_hours(limits.quiet_hours, now):
        return False, "quiet hours"
    counts = counts or {}
    if counts.get(action, 0) >= limits.cap(action, per_day=True):
        return False, f"daily {action} cap reached"
    if counts.get(hour_bucket(action, now), 0) >= limits.cap(action, per_day=False):
        return False, f"hourly {action} cap reached"
    return True, ""


def reserve_name(action: str) -> tuple[str, str]:
    """The two cache counters an action needs: per day and per hour."""
    return action, hour_bucket(action)
