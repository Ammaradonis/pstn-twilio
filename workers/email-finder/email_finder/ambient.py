"""The random math behind the ambient Instagram session.

The phone is only interesting to Instagram while nothing is being looked up, so
the worker keeps a session of ordinary Reels watching going: it scrolls with
gestures whose length, angle, speed and rhythm are drawn from distributions
rather than fixed, dwells on reels for a log-normal time, and now and then
engages -- a like, a follow, "Interested" on the overflow menu -- at rates that
are deliberately low and capped per hour and per day.

Why the numbers look the way they do
* Real scrolling is a mixture, not one speed: mostly fast flicks with momentum,
  some deliberate drags, the occasional small correction. `scroll()` draws the
  archetype first, then the numbers inside it.
* Watch time is right-skewed: most reels get a couple of seconds, a few get a
  long look. A log-normal with a rare "absorbed" tail matches that; a uniform
  draw would make every reel equally interesting, which no person is.
* Engagement is bursty and autocorrelated. A per-session `mood` (Beta) scales
  every action probability, and a fatigue term decays it as the session goes on,
  so a session reads as calm or lively rather than as a steady coin flip. An
  independent per-reel probability is the easiest possible pattern to detect.
* Actions keep a minimum spacing: nobody likes five reels in four seconds.
* Everything is capped per hour and per day (`AmbientSettings`), and every cap
  is env-tunable, because the caps -- not the randomness -- are what actually
  bounds the account's exposure.

Nothing here touches the phone: this module is pure decisions in, decisions out,
seeded so tests can pin a stream exactly.
"""

from __future__ import annotations

import math
import os
import random
import time
from dataclasses import dataclass

# ── defaults ────────────────────────────────────────────────────────────────

GESTURE_FLICK = (0.42, 0.62)  # travel as a fraction of screen height
GESTURE_DRAG = (0.22, 0.40)
GESTURE_NUDGE = (0.10, 0.20)
DURATION_FLICK = (130, 300)  # ms
DURATION_DRAG = (340, 620)
DURATION_NUDGE = (200, 450)
FLICK_ODDS, DRAG_ODDS = 0.60, 0.25  # remainder: nudge
SCROLL_BACK_ODDS = 0.18  # looking at the previous reel again
DIAGONAL_ODDS = 0.12  # a clearly angled swipe rather than thumb drift
DOUBLE_SCROLL_ODDS = 0.08  # two flicks in a row, paging fast
DWELL_MEDIAN, DWELL_SIGMA = 3.2, 0.75  # seconds, log-normal
LONG_WATCH_ODDS, LONG_WATCH = 0.06, (15.0, 45.0)
MOOD_BETA = (2.2, 5.5)  # right-skewed: most sessions are calm
FATIGUE = 0.12  # per ten reels, how fast a session settles down
COOLDOWN = {"like": (25.0, 90.0), "interest": (60.0, 240.0),
            "follow": (180.0, 600.0), "pause": (20.0, 70.0)}
ACTION_BASE = {"like": 0.10, "interest": 0.05, "follow": 0.012, "pause": 0.07}
MOOD_SCALE = {"like": (0.35, 1.30), "interest": (0.50, 1.00),
              "follow": (0.40, 1.20), "pause": (1.00, 0.00)}
SLICE_REELS = (3, 9)  # reels per phone slice, so a lookup never waits long
REST_SHORT = (2.0, 12.0)  # seconds between slices
REST_LONG_ODDS, REST_LONG = 0.22, (90.0, 420.0)  # the phone goes down a while
SESSION_REELS_MEDIAN, SESSION_REELS_SIGMA = 9.0, 0.6
SESSION_REELS_MAX = 60
TAP_GAP_MS = (80, 140)  # between the two taps of a double tap

ACTIONS = ("like", "interest", "follow", "pause")


@dataclass(frozen=True)
class Gesture:
    """One `input swipe`, in real screen pixels, with its archetype for logs."""
    x1: int
    y1: int
    x2: int
    y2: int
    duration: int
    kind: str

    def as_command(self) -> str:
        return f"input swipe {self.x1} {self.y1} {self.x2} {self.y2} {self.duration}"


@dataclass
class AmbientSettings:
    """Whether the session runs at all, what it may do, and how often."""
    enabled: bool = True
    like: bool = True
    interest: bool = True
    follow: bool = True
    pause: bool = True  # tap to pause the reel: changes nothing on the account
    likes_per_hour: int = 30
    likes_per_day: int = 180
    follows_per_hour: int = 4
    follows_per_day: int = 25
    interests_per_hour: int = 12
    interests_per_day: int = 60
    gestures_per_day: int = 1500
    slices_per_day: int = 180
    interest_positive_odds: float = 0.6  # "Interested" vs "Not interested"
    quiet_hours: tuple[int, int] | None = (2, 7)  # local; None disables
    stop_lookups_on_challenge: bool = True
    cap_hours: int = 12  # how long a challenge silences the phone entirely


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


def _pair(name: str, default: tuple[int, int]) -> tuple[int, int] | None:
    """`A-B` in the environment, or `off` for no quiet hours."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    if raw.strip().lower() in ("off", "0", "no", "none", ""):
        return None
    try:
        start, _, end = raw.partition("-")
        return int(start), int(end)
    except ValueError:
        return default


def ambient_settings() -> AmbientSettings:
    return AmbientSettings(
        enabled=_flag("EMAIL_FINDER_AMBIENT", True),
        like=_flag("EMAIL_FINDER_AMBIENT_LIKE", True),
        interest=_flag("EMAIL_FINDER_AMBIENT_INTEREST", True),
        follow=_flag("EMAIL_FINDER_AMBIENT_FOLLOW", True),
        pause=_flag("EMAIL_FINDER_AMBIENT_PAUSE", True),
        likes_per_hour=int(_num("EMAIL_FINDER_AMBIENT_LIKES_PER_HOUR", 30)),
        likes_per_day=int(_num("EMAIL_FINDER_AMBIENT_LIKES_PER_DAY", 180)),
        follows_per_hour=int(_num("EMAIL_FINDER_AMBIENT_FOLLOWS_PER_HOUR", 4)),
        follows_per_day=int(_num("EMAIL_FINDER_AMBIENT_FOLLOWS_PER_DAY", 25)),
        interests_per_hour=int(_num("EMAIL_FINDER_AMBIENT_INTERESTS_PER_HOUR", 12)),
        interests_per_day=int(_num("EMAIL_FINDER_AMBIENT_INTERESTS_PER_DAY", 60)),
        gestures_per_day=int(_num("EMAIL_FINDER_AMBIENT_GESTURES_PER_DAY", 1500)),
        slices_per_day=int(_num("EMAIL_FINDER_AMBIENT_SLICES_PER_DAY", 180)),
        interest_positive_odds=_num("EMAIL_FINDER_AMBIENT_INTEREST_POSITIVE_ODDS", 0.6),
        quiet_hours=_pair("EMAIL_FINDER_AMBIENT_QUIET_HOURS", (2, 7)),
        stop_lookups_on_challenge=_flag("EMAIL_FINDER_AMBIENT_STOP_LOOKUPS", True),
        cap_hours=int(_num("EMAIL_FINDER_AMBIENT_CHALLENGE_HOURS", 12)),
    )


def hour_bucket(kind: str, now: float | None = None) -> str:
    """Counter name for a per-hour cap (the cache counts by name and day)."""
    return f"{kind}@{time.strftime('%Y-%m-%dT%H', time.gmtime(now))}"


def in_quiet_hours(quiet: tuple[int, int] | None, now: float | None = None) -> bool:
    """Local wall-clock quiet hours, wrapping midnight (22-6, 2-7, ...)."""
    if not quiet:
        return False
    start, end = quiet
    hour = time.localtime(now).tm_hour
    if start == end:
        return False
    return start <= hour < end if start < end else (hour >= start or hour < end)


class ReelSession:
    """One stretch of watching Reels: its mood, its pace and its decisions.

    A session lives across phone slices so its mood, fatigue and action
    cooldowns carry over; the supervisor replaces it after a long break, which
    is when a person's attention would have reset anyway.
    """

    def __init__(self, settings: AmbientSettings, rng: random.Random | None = None,
                 clock=time.monotonic) -> None:
        self.s = settings
        self._rng = rng or random.Random()
        self._clock = clock
        self.mood = self._rng.betavariate(*MOOD_BETA)
        self.reels = 0
        self.limit = self._session_length()
        self._next_allowed: dict[str, float] = {}
        self._did: dict[str, int] = {name: 0 for name in ACTIONS}

    # ── shape of a session ───────────────────────────────────────────────────

    def _session_length(self) -> int:
        drawn = self._rng.lognormvariate(math.log(SESSION_REELS_MEDIAN), SESSION_REELS_SIGMA)
        return int(min(SESSION_REELS_MAX, max(4, drawn)))

    @property
    def finished(self) -> bool:
        return self.reels >= self.limit

    def slice_length(self) -> int:
        """Reels per phone slice; short, so a queued lookup waits seconds."""
        return self._rng.randint(*SLICE_REELS)

    def rest(self) -> float:
        """Pause before the next slice; sometimes long, like putting it down."""
        if self._rng.random() < REST_LONG_ODDS:
            return self._rng.uniform(*REST_LONG)
        return self._rng.uniform(*REST_SHORT)

    def record(self, action: str) -> None:
        """Note that an action really happened, and start its cooldown."""
        lo, hi = COOLDOWN.get(action, (0.0, 0.0))
        self._next_allowed[action] = self._clock() + self._rng.uniform(lo, hi)
        self._did[action] = self._did.get(action, 0) + 1

    def watched(self) -> None:
        self.reels += 1

    # ── one reel ─────────────────────────────────────────────────────────────

    def dwell(self) -> float:
        """Seconds to watch this reel before doing anything else."""
        if self._rng.random() < LONG_WATCH_ODDS:
            return self._rng.uniform(*LONG_WATCH)
        drawn = self._rng.lognormvariate(math.log(DWELL_MEDIAN), DWELL_SIGMA)
        return min(30.0, max(0.8, drawn))

    def scroll(self, width: int, height: int) -> Gesture:
        """A swipe in the thumb zone, away from the action rail and the nav bar."""
        roll = self._rng.random()
        if roll < FLICK_ODDS:
            span, duration, kind = self._rng.uniform(*GESTURE_FLICK), self._rng.randint(*DURATION_FLICK), "flick"
        elif roll < FLICK_ODDS + DRAG_ODDS:
            span, duration, kind = self._rng.uniform(*GESTURE_DRAG), self._rng.randint(*DURATION_DRAG), "drag"
        else:
            span, duration, kind = self._rng.uniform(*GESTURE_NUDGE), self._rng.randint(*DURATION_NUDGE), "nudge"
        x1 = int(self._rng.uniform(0.18, 0.70) * width)
        y1 = int(self._rng.uniform(0.58, 0.88) * height)
        travel = -span * height  # a thumb moving up: the next reel
        if self._rng.random() < SCROLL_BACK_ODDS:
            travel = -travel  # a thumb moving down: the reel before this one
        y2 = y1 + travel
        # Keep the whole gesture on screen, below the status bar and above the nav.
        y2 = int(min(max(y2, 0.12 * height), 0.94 * height))
        if self._rng.random() < DIAGONAL_ODDS:
            x2 = x1 + int(self._rng.choice((-1, 1)) * self._rng.uniform(0.06, 0.12) * width)
        else:
            x2 = x1 + int(max(-0.12, min(0.12, self._rng.gauss(0.0, 0.035))) * width)  # thumb drift
        x2 = int(min(max(x2, 0.06 * width), 0.80 * width))
        return Gesture(x1, y1, x2, y2, duration, kind)

    def paging_fast(self) -> bool:
        """True when the next swipe follows immediately, paging two reels."""
        return self._rng.random() < DOUBLE_SCROLL_ODDS

    def double_tap_gap(self) -> float:
        return self._rng.randint(*TAP_GAP_MS) / 1000.0

    # ── what to do about it ──────────────────────────────────────────────────

    def action(self, allowed: dict[str, bool] | None = None) -> str:
        """The action for the reel just watched: one of ACTIONS, or "none"."""
        allowed = allowed if allowed is not None else {}
        mood = self.mood * math.exp(-FATIGUE * self.reels / 10.0)
        now = self._clock()
        weights: dict[str, float] = {}
        for name in ACTIONS:
            if not getattr(self.s, name, True) or not allowed.get(name, True):
                continue
            if now < self._next_allowed.get(name, 0.0):
                continue  # a person does not do the same thing twice in a row
            floor, slope = MOOD_SCALE[name]
            weights[name] = ACTION_BASE[name] * (floor + slope * mood)
        total = sum(weights.values())
        if total <= 0:
            return "none"
        # `total` is the chance of doing anything at all (well under 1); which
        # action it is comes from the weights below. Drawing the identity from
        # the same roll would make every reel an action, which is exactly the
        # burst pattern the caps exist to avoid.
        roll = self._rng.random()
        if roll > min(1.0, total):
            return "none"
        seen = 0.0
        for name in ACTIONS:
            if name not in weights:
                continue
            seen += weights[name]
            if roll <= seen:
                return name
        return "none"

    def picks_interested(self) -> bool:
        return self._rng.random() < self.s.interest_positive_odds

    def describe(self) -> str:
        did = ", ".join(f"{n}={c}" for n, c in self._did.items() if c) or "nothing yet"
        return (f"mood {self.mood:.2f}, reel {self.reels}/{self.limit}, {did}")
