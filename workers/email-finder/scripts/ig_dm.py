"""Instagram DM outreach to martial arts schools, from @matboss_online only, on the Galaxy A20e.

    python scripts/ig_dm.py sync                  # load the Texas tab's Instagram leads
    python scripts/ig_dm.py preview --n 8         # print messages; nothing touches the phone
    python scripts/ig_dm.py probe                 # walk one lead up to the empty message box, send nothing
    python scripts/ig_dm.py run --loop            # 50 a day, every day, inside the Texas daytime window
    python scripts/ig_dm.py report                # who got a message, and why the rest did not

From the project root, ig-dm.cmd runs the same commands.

What it does, per lead: opens the school's profile in the Instagram app, taps its
Message button, checks that the thread belongs to that school and has no earlier
conversation, types the message, checks that the box holds exactly that text, taps
Send and checks that the message appeared. A step that cannot be verified stops
that lead without sending; nothing is ever sent twice (a lead is marked before
Send is tapped, so a crash mid-send never leads to a second message).

The account: before every batch it opens the app's own profile and requires
@matboss_online (with an Edit profile button, so it is the signed-in account and
not someone else's page). If another account is active and @matboss_online is in
the app's account switcher, it switches, sends the batch, and switches back. It
never signs in, never taps a login, "add account" or security screen.

The message: personal and different for every school (owner's first name, school,
city, Google rating, and what happened when the school was called from the 877
line), and never a URL. `compose` refuses any text that looks like a link.

Pacing: 50 a day by the Texas (US Central) calendar, weekends included, between
09:00 and 21:00 Central, in small batches with gaps sized to finish the day's 50.
It shares the email finder's phone lock and pauses. A "try again later", "action
blocked" or failed send stops all DMs for 24 hours and Instagram lookups for 12;
a security or login screen pauses the phone as the worker does. The user clears
those on the phone; this never tries to get past one.

State is in .cache/ig-dm.sqlite; the log is .cache/ig-dm.log.
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import hashlib
import json
import logging
import os
import random
import re
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.android import (  # noqa: E402
    DEVICE_NAME, INSTAGRAM, Galaxy, Node, PhoneUnavailable, find_adb, find_button,
    instagram_profile_shown, user_not_found,
)
from email_finder.cache import Cache  # noqa: E402
from email_finder.config import CACHE_DIR  # noqa: E402

log = logging.getLogger("ig_dm")

ACCOUNT = "matboss_online"
SPREADSHEET_ID = "1hEen_n9M27n5bjyXpsnaHXpvG7S5eHHmPl6HG2LhRnM"  # U.S. Conquest
DEFAULT_TAB = "Texas"
DB_PATH = CACHE_DIR / "ig-dm.sqlite"
SCREENS_DIR = CACHE_DIR / "ig-dm-screens"
SENT_CSV = CACHE_DIR / "ig-dm-sent.csv"

DAILY = 50
HOURLY = 12
WINDOW = (9, 21)  # Central hours, start inclusive, end exclusive
BATCH = (3, 6)
IN_BATCH_GAP = (70.0, 200.0)  # seconds between two messages of one batch
MIN_GAP, MAX_GAP = 5 * 60, 100 * 60  # between batches
DM_PAUSE_S = 24 * 3600
MAX_FAILURES = 4  # structural failures in a row before a 3 h rest
FAILURE_REST_S = 3 * 3600
MAX_ATTEMPTS = 2  # per lead, for failures that sent nothing

HANDLE = re.compile(r"^[a-z0-9._]{1,30}$")
IG_URL = re.compile(r"instagram\.com/([^/?#\s]+)", re.I)
NOT_HANDLES = frozenset((
    "p", "reel", "reels", "explore", "stories", "tv", "accounts", "direct", "about", "legal",
    # Platforms whose account a scraper picked up from a site footer, not the school's.
    "wix", "squarespace", "godaddy", "wordpress", "wordpressdotcom", "shopify", "weebly", "mindbody",
    "mindbodyapp", "instagram", "facebook", "meta", "linktree", "linktr.ee", "google", "yelp",
    "gymdesk", "zenplanner", "kicksite", "sparkmembership", "wodify", "pushpress", "glofox",
))
MARTIAL = re.compile(r"martial|karate|judo|jiu|jitsu|taekwondo|tae kwon|boxing|muay|kickbox|wrestl|mma|"
                     r"self defen[cs]e|kung fu|aikido|krav|fight|hapkido|kenpo|capoeira|dojo|grappl", re.I)
NOT_MARTIAL = re.compile(r"ballet|yoga|dance|pilates|swim", re.I)
URLISH = re.compile(
    r"https?:|www\.|://|\b[\w-]+\.(?:com|net|org|io|co|us|ai|app|biz|info|me|online|site|studio|academy|fit|"
    r"gym|tv|ly|gg|link|page|store|shop|club|school|edu|gov)\b", re.I)
EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿\U0001F1E6-\U0001F1FF]")
DEMO_LINE = "(667) 220-6726"

# What a screen says when Instagram pushes back on the account (stop everything)
# or refuses this one recipient (skip the lead).
PUSHBACK = re.compile(r"try again later|we restrict certain|action blocked|unusual activity|limit how often|"
                      r"couldn.t send|could not send|failed to send|not sent|tap to retry|message failed|"
                      r"you.re temporarily blocked|temporarily restricted", re.I)
RECIPIENT_REFUSES = re.compile(r"can.t (?:message|send messages to) this account|isn.t accepting messages|"
                               r"can.t receive (?:your )?messages|you can.t message|not accepting message", re.I)
COMPOSER_HINT = re.compile(r"^(?:message|write a message|send a message|nachricht(?: schreiben)?)\s*(?:\.\.\.|…)?$",
                           re.I)
MESSAGE_LABELS = ("message", "nachricht", "nachricht senden")
SEND_LABELS = ("send", "senden")
EDIT_PROFILE = ("Edit profile", "Profil bearbeiten")
UI_WORDS = frozenset(("back", "menu", "options", "create", "more", "settings", "new", "threads", "zurück", "optionen",
                      "erstellen", "home", "search", "reels", "profile", "edit", "share", "notifications"))
HISTORY_RIDS = ("direct_text_message_text_view", "message_text", "message_content", "text_message")
LOGIN_WORDS = re.compile(r"log ?in|sign ?up|add (?:instagram )?account|accounts center|create new account", re.I)


class Pushback(RuntimeError):
    """Instagram pushed back; DMs (and lookups) are paused, the user clears it."""


class AccountProblem(RuntimeError):
    """@matboss_online is not the active account and could not be switched to."""


class ScreenProblem(RuntimeError):
    """A step could not be verified on screen; nothing was sent."""


class Skip(LookupError):
    """This lead can never be messaged (the account is gone, or refuses messages)."""


class Held(LookupError):
    """Not messaged for a reason a screen misread could also produce (no Message
    button, an earlier conversation). Kept apart so `requeue` can undo it."""


class Paused(RuntimeError):
    """The phone or Instagram was paused (by any process) while this batch waited
    for the phone or between its leads; the loop goes back to waiting."""


class PhoneBusy(RuntimeError):
    """Another process kept the phone past PHONE_WAIT_S. Not a failure: try again soon."""


PHONE_WAIT_S = 600


class Offline(RuntimeError):
    """The phone has no internet. Offline, Instagram shows a deleted account's
    "page isn't available" and endless spinners, so no lead is judged then."""


# The phone is online when it reaches Instagram, or failing that a public DNS
# server (in case a network drops ICMP to Instagram only).
ONLINE_HOSTS = ("i.instagram.com", "8.8.8.8")
PING_OK = re.compile(r"\b[1-9]\d* (?:packets )?received")


# ── Texas time ───────────────────────────────────────────────────────────────

def central_offset(utc: datetime) -> int:
    """US Central's UTC offset in hours (DST: second Sunday of March 2:00 to
    first Sunday of November 2:00 local). This Python has no tz database."""
    y = utc.year
    march = date(y, 3, 1)
    dst_start = march + timedelta(days=(6 - march.weekday()) % 7 + 7)
    nov = date(y, 11, 1)
    dst_end = nov + timedelta(days=(6 - nov.weekday()) % 7)
    start = datetime(y, 3, dst_start.day, 8, tzinfo=timezone.utc)   # 02:00 CST
    end = datetime(y, 11, dst_end.day, 7, tzinfo=timezone.utc)      # 02:00 CDT
    return -5 if start <= utc < end else -6


def central(now: float | None = None) -> datetime:
    utc = datetime.fromtimestamp(time.time() if now is None else now, tz=timezone.utc)
    return (utc + timedelta(hours=central_offset(utc))).replace(tzinfo=None)


def central_day(now: float | None = None) -> str:
    return central(now).strftime("%Y-%m-%d")


def seconds_until_window(now: float | None = None, window: tuple[int, int] = WINDOW) -> float:
    """0 inside the window, else seconds until it next opens."""
    local = central(now)
    start, end = window
    if start <= local.hour < end:
        return 0.0
    opens = local.replace(hour=start, minute=0, second=0, microsecond=0)
    if local.hour >= end:
        opens += timedelta(days=1)
    return (opens - local).total_seconds()


def seconds_until_next_day(now: float | None = None, window: tuple[int, int] = WINDOW) -> float:
    """Seconds until the window opens on the next Texas calendar day."""
    local = central(now)
    opens = (local + timedelta(days=1)).replace(hour=window[0], minute=0, second=0, microsecond=0)
    return (opens - local).total_seconds()


def seconds_left_in_window(now: float | None = None, window: tuple[int, int] = WINDOW) -> float:
    local = central(now)
    closes = local.replace(hour=window[1], minute=0, second=0, microsecond=0)
    return max(0.0, (closes - local).total_seconds())


# ── leads from the sheet ─────────────────────────────────────────────────────

def handle_of(url: str) -> str | None:
    m = IG_URL.search(url or "")
    if not m:
        return None
    handle = m[1].strip().lstrip("@").lower()
    if not HANDLE.match(handle) or handle in NOT_HANDLES:
        return None
    return handle


def first_name(decision_maker: str) -> str:
    """'Kathy Snyder (owner)' -> 'Kathy'; '' when it does not look like a person."""
    name = re.sub(r"\(.*?\)", "", decision_maker or "").strip()
    if not name or re.search(r"\d|martial|academy|karate|studio|school|team|staff|llc|inc\b", name, re.I):
        return ""
    first = re.split(r"[\s,/&]+", name)[0].strip(".’'")
    if not re.fullmatch(r"[A-Za-zÀ-ÿ]{2,20}", first):
        return ""
    return first if not first.isupper() and not first.islower() else first.capitalize()


def school_name(title: str) -> str:
    name = re.sub(r"\s+", " ", (title or "").strip())
    if name.isupper() and len(name) > 4:
        name = " ".join(w if len(w) <= 3 and w.isalpha() and w in {"MMA", "BJJ", "ATA", "USA", "TKD", "UFC"}
                        else w.capitalize() for w in name.split())
    return name


def brand_name(titles: list[str]) -> str:
    """One location's name, or what several locations' names share
    ('Premier Martial Arts West', 'Premier Martial Arts Katy' -> 'Premier Martial Arts')."""
    titles = [clean_title(t) for t in titles if t]
    if len(titles) <= 1:
        return titles[0] if titles else ""
    counts: dict[str, int] = {}
    spelled: dict[str, str] = {}
    for title in titles:
        words = [w.strip(",.:;|") for w in title.split()]
        for n in range(2, len(words) + 1):
            key = " ".join(words[:n]).casefold()
            counts[key] = counts.get(key, 0) + 1
            spelled.setdefault(key, " ".join(words[:n]))
    best = max(counts, key=lambda k: (counts[k], len(k)), default="")
    return spelled[best] if best and counts[best] >= 2 else titles[0]


def clean_title(title: str) -> str:
    """'Victory Martial Arts - Bandera' -> 'Victory Martial Arts'; 'X Plano, Tx' -> 'X Plano'."""
    title = re.split(r"\s[-|–—]\s|\s\(", title)[0]
    return re.sub(r",?\s+(?:TX|Texas)\.?$", "", title.strip(), flags=re.I).strip(" ,") or title


def city_of(address: str, state_code: str = "TX") -> str:
    m = re.search(rf",\s*([^,]+?),\s*{state_code}\b", address or "")
    return m[1].strip() if m else ""


def call_kind(status: str) -> str:
    """The first part of the Status cell (what happened when the school was called)."""
    s = (status or "").strip().lower()
    for kind, pattern in (("not_interested", r"^not interested"), ("out_of_service", r"^out of service"),
                          ("rang_out", r"^rang out"), ("voicemail", r"^voicemail"), ("busy", r"^line (?:is |was )?busy"),
                          ("silent", r"^stayed silent"), ("receptionist", r"^has a receptionist"),
                          ("ai", r"^has an ai|^has an answering service"), ("hung_up", r"^hung up")):
        if re.match(pattern, s):
            return kind
    return ""


def _num(text: str) -> float:
    try:
        return float(str(text).replace(",", "").strip())
    except ValueError:
        return 0.0


@dataclass
class Lead:
    handle: str
    tab: str
    rows: str  # sheet row numbers, comma separated
    school: str
    city: str
    first: str
    kind: str
    rating: float
    reviews: int
    locations: int
    priority: int
    skip: str = ""  # why it is never messaged ('' = it may be)


def build_leads(tab: str, values: list[list[str]], state_code: str = "TX") -> list[Lead]:
    """One lead per Instagram handle, from the tab's rows (header first)."""
    if not values:
        return []
    header = [str(h).strip() for h in values[0]]
    col = {h: i for i, h in enumerate(header)}

    def cell(row: list[str], name: str) -> str:
        i = col.get(name)
        return str(row[i]).strip() if i is not None and i < len(row) else ""

    grouped: dict[str, list[tuple[int, list[str]]]] = {}
    for number, row in enumerate(values[1:], start=2):
        handle = handle_of(cell(row, "instagramUrl"))
        if handle:
            grouped.setdefault(handle, []).append((number, row))
    leads = []
    for handle, rows in grouped.items():
        number, row = rows[0]
        kinds = {call_kind(cell(r, "Status")) for _, r in rows}
        firsts = {first_name(cell(r, "decisionMaker")) for _, r in rows} - {""}
        cities = {city_of(cell(r, "address"), state_code) for _, r in rows} - {""}
        kind = "not_interested" if "not_interested" in kinds else (call_kind(cell(row, "Status")) if len(rows) == 1 else "")
        category = cell(row, "category")
        skip = ""
        if "not_interested" in kinds:
            skip = "said not interested on the phone"
        elif cell(row, "businessStatus").upper() in ("CLOSED_PERMANENTLY", "TEMPORARILY_CLOSED"):
            skip = f"Google says {cell(row, 'businessStatus').lower().replace('_', ' ')}"
        elif cell(row, "qualityClass").upper() == "REJECT":
            skip = "rejected by the sheet's quality check"
        elif NOT_MARTIAL.search(category) or (cell(row, "relevance") != "relevant" and not MARTIAL.search(
                f"{category} {cell(row, 'title')}")):
            skip = f"not a martial arts business ({category or 'no category'})"
        reviews = int(_num(cell(row, "reviewCount")))
        first = next(iter(firsts)) if len(firsts) == 1 else ""
        priority = (0 if kind and kind not in ("hung_up",) else 1 if first else 2)
        leads.append(Lead(
            handle=handle, tab=tab, rows=",".join(str(n) for n, _ in rows),
            school=brand_name([school_name(cell(r, "title")) for _, r in rows]) or school_name(cell(row, "title")),
            city=next(iter(cities)) if len(cities) == 1 else "",
            first=first, kind=kind, rating=_num(cell(row, "rating")), reviews=reviews,
            locations=len(rows), priority=priority, skip=skip))
    return leads


# ── the message ──────────────────────────────────────────────────────────────

GREET_NAMED = ("Hey {first}!", "Hi {first} 👋", "Hey {first}, hope the mats are treating you well!",
               "{first}! Hope your week is off to a great start.", "Hey {first}, hope today's classes are going great!",
               "Good to meet you, {first}!")
GREET_TEAM = ("Hey {school} team!", "Hi there, {school} crew 👋", "Hey friends at {school}!",
              "Hello {school} family!")

HOOK_RATED = (
    "{rating} stars from {reviews} Google reviews? That isn't a reputation, that's a black belt in making families happy 🥋",
    "{reviews} Google reviews at {rating} stars tells me the parents in {city} already know you're the real deal.",
    "I was looking at martial arts schools around {city} and {school} stood out right away. "
    "{rating} stars from {reviews} reviews doesn't happen by accident.",
    "Had to reach out. {rating} stars across {reviews} Google reviews is the kind of thing that makes other schools "
    "in {city} a little jealous 😄",
    "Just saw {school} sitting at {rating} stars with {reviews} reviews. That kind of love from families in {city} "
    "is earned on the mat, not bought 🥋",
)
HOOK_PLAIN = (
    "I came across {school} while looking at martial arts schools around {city} and just had to say hi.",
    "I've been looking into martial arts schools around {city}, and {school} kept popping up, so here I am saying hi 😄",
    "I've been checking out martial arts schools around {city}, and {school} looks like the kind of place students "
    "actually look forward to.",
)
HOOK_CHAIN = (
    "I came across {school} while looking at martial arts schools across Texas. {locations} locations is seriously impressive!",
    "I came across {school} while looking at martial arts schools across Texas. {locations} locations? "
    "That's a whole dojo empire 🥋",
)
HOOK_CALL = {
    "rang_out": (
        "I called {school} a little while back and it just rang and rang. Totally get it, "
        "you were probably on the mat doing the real work 😄",
        "I gave {school} a ring a little while back and nobody could grab it. Honestly that usually means class was in full swing!",
        "I called {school} a little while back and the phone just kept ringing. My guess is you were in the middle "
        "of a class, which is the best excuse there is 😄",
    ),
    "voicemail": (
        "I called {school} a little while back and met your voicemail instead of you. No shade at all, "
        "the best instructors are on the mat, not on the phone 😄",
        "I tried calling {school} a little while back and landed in voicemail. Honestly I took it as a sign you were "
        "busy teaching, which is exactly where you should be 🥋",
        "I called {school} a little while back and got the voicemail. Totally fair, nobody can block a kick and grab "
        "the phone at the same time 😄",
        "Fun fact: I called {school} a little while back and your voicemail beat you to it. Can't blame you, "
        "class comes first!",
    ),
    "busy": ("I called {school} a little while back and got a busy signal, which honestly sounds like business is booming 😄",),
    "silent": ("I called {school} a little while back and the line connected, then... total silence. Very stealthy, very ninja 🥷",),
    "receptionist": ("I called {school} a little while back and a real person picked up, which already puts you ahead "
                     "of most schools I call!",),
    "ai": ("I called {school} a little while back and something picked up for you, which already puts you ahead of "
           "most schools in {city}.",),
    "out_of_service": ("Quick heads up first: when I called the number Google lists for {school}, it said the number is "
                       "out of service. Might be worth a look, parents could be hitting the same wall.",),
}
PITCH = (
    "I'm Ammar, and I build AI phone agents just for martial arts schools. They pick up every call on the first ring, "
    "answer the how much and what ages questions, and book the trial class while you're teaching.",
    "Quick intro, I'm Ammar from MatBoss. We build AI receptionists for martial arts schools that answer every call, "
    "day and night, and book trial classes straight onto your schedule.",
    "I'm Ammar. I build phone agents for martial arts schools so no parent ever hits voicemail again. "
    "They answer, chat like your friendliest front desk, and book the trial class for you.",
    "Quick intro, I'm Ammar. I build AI phone agents for martial arts schools. They answer every call like your best "
    "front desk person on their best day, then book the trial class on the spot.",
    "I'm Ammar from MatBoss. We build AI receptionists made just for martial arts schools. They answer every call, "
    "handle the price and schedule questions, and get the trial class booked, even at 9pm on a Sunday.",
)
PITCH_FOR = {
    "receptionist": ("I'm Ammar from MatBoss. We build AI phone agents for martial arts schools that back up your front "
                     "desk, so calls during breaks, after hours and on weekends still get answered and booked.",),
    "ai": ("I'm Ammar from MatBoss. Our AI phone agents are built only for martial arts schools, so they don't just "
           "answer, they book the trial class right there on the call.",),
}
CTA = (
    "Want to hear it? Call the demo at {demo} and throw your toughest parent question at it.",
    "The demo line is {demo}. Give it a call between classes and try to stump it, I dare you 😄",
    "If you've got a minute between classes, call {demo} and play a curious parent. I think you'll grin.",
    "Curious? Call the demo line at {demo}, pretend you're a parent, and see if it earns its stripe.",
    "The easiest way to judge it is to hear it: {demo}. Call like a parent shopping for classes.",
)
CLOSE = (
    "Would love to hear what you think. And if it's not your thing, just say so and I won't bug you again 🙏",
    "Either way, keep doing what you're doing. {city} is lucky to have you!",
    "No pressure at all. If it's not for you, tell me and I'll vanish like a good ninja 🥷",
    "Would genuinely love your honest take. If it's not a fit, just say the word and I'll bow out 🙏",
    "Either way, thanks for building something special in {city}!",
)


def _pick(options: tuple[str, ...], seed: str, part: str) -> str:
    digest = hashlib.sha256(f"{seed}:{part}".encode()).digest()
    return options[digest[0] % len(options)]


def _cap_emoji(parts: list[str], limit: int = 2) -> list[str]:
    """Keep the first `limit` emoji; a message full of them reads like a bot. A
    sentence that loses its closing emoji gets a full stop instead."""
    seen = 0

    def keep(m: re.Match) -> str:
        nonlocal seen
        seen += 1
        return m[0] if seen <= limit else ""

    out = []
    for i, part in enumerate(parts):
        trimmed = re.sub(r"\s?" + EMOJI.pattern, keep, part).strip()
        if trimmed != part.strip() and trimmed and trimmed[-1].isalnum():
            trimmed += "!" if i == 0 else "."
        out.append(trimmed)
    return out


# Motifs that make a message sound canned when they show up twice.
ECHO = (r"\bninja\b", r"\bmats?\b", r"between classes", r"\bgrin\b", r"\bdare\b", r"\bbow\b",
        r"in the middle of a class|class was in full swing|busy teaching|while you're teaching")


def _pick_fresh(options: tuple[str, ...], seed: str, part: str, used: str) -> str:
    """Like _pick, but avoids an option that repeats a motif already in the message."""
    fresh = tuple(o for o in options
                  if not any(re.search(w, o, re.I) and re.search(w, used, re.I) for w in ECHO))
    return _pick(fresh or options, seed, part)


def strip_emoji(text: str) -> str:
    return re.sub("[\ufe0f\u200d]", "", EMOJI.sub("", text or ""))


def compose(lead: Lead, seed: str | None = None) -> str:
    """The DM for one lead. Deterministic per handle, so preview shows what run sends."""
    seed = seed or lead.handle
    school = lead.school if lead.school and not URLISH.search(lead.school) else "your school"
    city = lead.city or "Texas"
    fields = {"first": lead.first, "school": school, "city": city, "demo": DEMO_LINE,
              "rating": f"{lead.rating:.1f}".rstrip("0").rstrip(".") if lead.rating else "",
              "reviews": f"{lead.reviews:,}", "locations": lead.locations}
    if school == "your school":
        greet = _pick(GREET_NAMED, seed, "greet") if lead.first else "Hey there!"
    else:
        greet = _pick(GREET_NAMED if lead.first else GREET_TEAM, seed, "greet")
    if lead.locations > 1:
        hooks = HOOK_CHAIN
        fields["city"] = "Texas"
    elif lead.kind in HOOK_CALL:
        hooks = HOOK_CALL[lead.kind]
    elif lead.rating >= 4.5 and lead.reviews >= 20:
        hooks = HOOK_RATED
    else:
        hooks = HOOK_PLAIN
    hook = _pick_fresh(hooks, seed, "hook", greet)
    if "{school}" in greet or school == "your school":
        # The greeting already names the school; saying it twice reads like a mail merge.
        for old, new in (("I called {school}", "I called your school"), ("I tried calling {school}", "I tried calling you"),
                         ("I gave {school} a ring", "I gave you a ring"), ("{school} stood out", "you stood out"),
                         ("and {school} kept popping up", "and you kept popping up"), ("lists for {school}", "lists for you"),
                         ("I came across {school}", "I came across your school"),
                         ("Just saw {school} sitting at", "Just saw you sitting at"),
                         ("and {school} looks like", "and your school looks like")):
            hook = hook.replace(old, new)
    pitch = _pick_fresh(PITCH_FOR.get(lead.kind, PITCH), seed, "pitch", greet + hook)
    sign = "Ammar" if "MatBoss" in pitch else "Ammar, MatBoss"
    cta = _pick_fresh(CTA, seed, "cta", greet + hook + pitch)
    close = _pick_fresh(CLOSE, seed, "close", greet + hook + pitch + cta)
    if lead.kind == "out_of_service":
        close = CLOSE[0]  # no "keep doing what you're doing" after a broken number
    parts = [p.format(**fields) for p in (greet, hook, f"{pitch} {cta}", close)]
    parts = _cap_emoji(parts)
    text = "\n\n".join(parts) + f"\n{sign}"
    problems = message_problems(text, allowed=(school,))
    if problems:
        raise ValueError(f"refusing to send to @{lead.handle}: {problems}")
    return text


def message_problems(text: str, allowed: tuple[str, ...] = ()) -> str:
    """'' when the text may be sent: no link of any kind, no hyphenated words, sane size.

    The house style (as in the follow-up emails) has no hyphens except inside the
    demo number; a school's own name may have one."""
    if URLISH.search(text):
        return "it contains something that looks like a link"
    if "@" in text:
        return "it contains an @"
    if "{" in text or "}" in text:
        return "a template field was left unfilled"
    rest = text.replace(DEMO_LINE, "")
    for name in allowed:
        rest = rest.replace(name, "")
    if "-" in rest or "\u2014" in rest or "\u2013" in rest:
        return "it contains a hyphen or dash"
    if not 150 <= len(text) <= 900:
        return f"it is {len(text)} characters"
    if len(EMOJI.findall(text)) > 2:
        return "too many emoji"
    return ""


def normalize(text: str) -> str:
    """Whitespace and emoji folded away: a screen dump may render either differently."""
    return re.sub(r"\s+", " ", strip_emoji(text)).strip()


# ── state ────────────────────────────────────────────────────────────────────

FINAL = ("sent", "unverified", "sending")  # never messaged again


class Store:
    def __init__(self, path: Path = DB_PATH) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            create table if not exists leads (
                handle text primary key, tab text, rows text, school text, city text, first text,
                kind text, rating real, reviews integer, locations integer, priority integer,
                state text not null default 'queued', why text default '', attempts integer default 0,
                message text, account text, sent_at real, sent_day text, synced_at real);
            create table if not exists meta (k text primary key, v text);
        """)

    def recover(self) -> None:
        """A send cut off by a crash may have gone out: it is never retried."""
        self.db.execute("update leads set state='unverified', why='interrupted while sending' where state='sending'")
        self.db.commit()

    def upsert(self, leads: list[Lead]) -> dict[str, int]:
        """New handles are added; queued ones, and ones the sheet's own data skipped, follow the
        sheet (a school marked "not interested" later is skipped). Phone results stay."""
        added = updated = 0
        now = time.time()
        for lead in leads:
            old = self.db.execute("select state, why from leads where handle=?", (lead.handle,)).fetchone()
            state = "skipped" if lead.skip else "queued"
            if old is None:
                self.db.execute(
                    "insert into leads (handle, tab, rows, school, city, first, kind, rating, reviews, locations, "
                    "priority, state, why, synced_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (lead.handle, lead.tab, lead.rows, lead.school, lead.city, lead.first, lead.kind, lead.rating,
                     lead.reviews, lead.locations, lead.priority, state, lead.skip, now))
                added += 1
            elif old["state"] == "queued" or (old["state"] == "skipped" and old["why"] and not old["why"].startswith(
                    ("phone:", "refusing"))):
                self.db.execute(
                    "update leads set tab=?, rows=?, school=?, city=?, first=?, kind=?, rating=?, reviews=?, "
                    "locations=?, priority=?, state=?, why=?, synced_at=? where handle=?",
                    (lead.tab, lead.rows, lead.school, lead.city, lead.first, lead.kind, lead.rating, lead.reviews,
                     lead.locations, lead.priority, state, lead.skip, now, lead.handle))
                updated += 1
        self.db.commit()
        return {"added": added, "updated": updated}

    def requeue(self, which: str = "held") -> int:
        """Put held (or failed) leads back in the queue, after a misread screen was fixed."""
        cur = self.db.execute("update leads set state='queued', why='', attempts=0 where state=?", (which,))
        self.db.commit()
        return cur.rowcount

    def lead(self, row: sqlite3.Row) -> Lead:
        return Lead(row["handle"], row["tab"], row["rows"], row["school"], row["city"], row["first"], row["kind"],
                    row["rating"], row["reviews"], row["locations"], row["priority"])

    def next(self, n: int) -> list[Lead]:
        rows = self.db.execute(
            "select * from leads where state='queued' and attempts < ? order by priority, reviews desc, handle limit ?",
            (MAX_ATTEMPTS, n)).fetchall()
        return [self.lead(r) for r in rows]

    def mark(self, handle: str, state: str, why: str = "", **extra) -> None:
        sets = ["state=?", "why=?"] + [f"{k}=?" for k in extra]
        self.db.execute(f"update leads set {', '.join(sets)} where handle=?",
                        (state, why, *extra.values(), handle))
        self.db.commit()

    def failed_attempt(self, handle: str, why: str) -> None:
        self.db.execute("update leads set attempts = attempts + 1, why=?, state = case when attempts + 1 >= ? "
                        "then 'failed' else state end where handle=?", (why, MAX_ATTEMPTS, handle))
        self.db.commit()

    def sent_on(self, day: str) -> int:
        return self.db.execute("select count(*) from leads where sent_day=? and state in ('sent','unverified')",
                               (day,)).fetchone()[0]

    def sent_since(self, ts: float) -> int:
        return self.db.execute("select count(*) from leads where sent_at>=? and state in ('sent','unverified')",
                               (ts,)).fetchone()[0]

    def get_meta(self, key: str, default: str = "") -> str:
        row = self.db.execute("select v from meta where k=?", (key,)).fetchone()
        return row["v"] if row else default

    def set_meta(self, key: str, value: str) -> None:
        self.db.execute("insert or replace into meta values (?, ?)", (key, value))
        self.db.commit()

    def dm_pause_left(self) -> float:
        return max(0.0, float(self.get_meta("pause_until", "0")) - time.time())

    def pause(self, seconds: float, why: str) -> None:
        self.set_meta("pause_until", str(time.time() + seconds))
        self.set_meta("pause_why", why)

    def counts(self) -> dict[str, int]:
        return {r["state"]: r["n"] for r in self.db.execute("select state, count(*) n from leads group by state")}


def sync(store: Store, tab: str = DEFAULT_TAB, state_code: str = "TX") -> dict[str, int]:
    from email_finder.fb_addresses import _session, read_tab

    values = read_tab(_session(), SPREADSHEET_ID, [f"'{tab}'!A1:Z"])[0]
    leads = build_leads(tab, values, state_code)
    result = store.upsert(leads)
    store.set_meta(f"synced:{tab}", str(time.time()))
    log.info("Synced %s: %d handles (%d to skip); %s", tab, len(leads), sum(1 for x in leads if x.skip), result)
    return result


# ── the phone ────────────────────────────────────────────────────────────────

def ig(nodes: list[Node]) -> list[Node]:
    return [n for n in nodes if n.package == INSTAGRAM and n.bounds[2] > n.bounds[0] and n.bounds[3] > n.bounds[1]]


def screen_height(nodes: list[Node]) -> int:
    return max((n.bounds[3] for n in nodes), default=1560) or 1560


def clickable_at(nodes: list[Node], target: Node) -> Node | None:
    """The node itself when clickable, else the smallest clickable node around it."""
    if target.clickable:
        return target
    x, y = target.center
    around = [n for n in nodes if n.clickable and n.bounds != (0, 0, 0, 0) and n.holds(x, y)]
    return min(around, key=lambda n: (n.bounds[2] - n.bounds[0]) * (n.bounds[3] - n.bounds[1]), default=None)


def pushback_on(nodes: list[Node]) -> str:
    for n in ig(nodes):
        if n.label and PUSHBACK.search(n.label) and "edittext" not in n.cls.lower():
            return n.label[:120]
    return ""


def recipient_refuses(nodes: list[Node]) -> str:
    for n in ig(nodes):
        if n.label and RECIPIENT_REFUSES.search(n.label):
            return n.label[:120]
    return ""


def profile_message_button(nodes: list[Node]) -> Node | None:
    """The profile's own Message button, in the row with Follow, never the inbox tab."""
    nodes = ig(nodes)
    follow = next((n for n in nodes if n.rid.endswith("/profile_header_follow_button")), None)
    candidates = []
    for n in nodes:
        if n.label.casefold() not in MESSAGE_LABELS or n.rid.endswith("/direct_tab"):
            continue
        target = clickable_at(nodes, n)
        if target is None or target.rid.endswith("/direct_tab"):
            continue
        if follow is not None and abs(target.center[1] - follow.center[1]) > 60:
            continue
        if follow is None and not target.rid.endswith("/button_container"):
            continue
        candidates.append(target)
    return candidates[0] if candidates else None


def account_title(nodes: list[Node]) -> Node | None:
    """The username at the top of the app's own profile (never a toolbar button)."""
    height = screen_height(nodes)
    titles = [n for n in ig(nodes) if n.center[1] < height * 0.12 and n.label
              and any(part in n.rid.split("/")[-1] for part in ("title", "username", "name"))
              and re.fullmatch(r"@?[A-Za-z0-9._]{1,30}", n.label.strip())
              and n.label.strip().casefold() not in UI_WORDS]
    titles.sort(key=lambda n: (0 if "title" in n.rid else 1, n.center[1]))
    return titles[0] if titles else None


def full_name_on_profile(nodes: list[Node]) -> str:
    for n in ig(nodes):
        if n.rid.split("/")[-1].startswith("profile_header_full_name") and n.label:
            return n.label.strip()
    return ""


def composer(nodes: list[Node]) -> Node | None:
    """The thread's message box: an EditText in the lower half of the screen."""
    height = screen_height(nodes)
    boxes = [n for n in ig(nodes) if "edittext" in n.cls.lower() and n.center[1] > height * 0.5]
    if not boxes:
        boxes = [n for n in ig(nodes) if "composer" in n.rid and ("edit" in n.rid or "text" in n.rid)
                 and n.center[1] > height * 0.5]
    return boxes[-1] if boxes else None


def composer_text(node: Node | None) -> str:
    if node is None:
        return ""
    text = node.text or ""
    return "" if COMPOSER_HINT.match(text.strip()) else text


def send_button(nodes: list[Node]) -> Node | None:
    height = screen_height(nodes)
    for n in ig(nodes):
        if n.label.strip().casefold() in SEND_LABELS and n.center[1] > height * 0.5:
            return clickable_at(nodes, n)
    return None


def thread_is_with(nodes: list[Node], handle: str, full_name: str) -> bool:
    """The thread's header names the school (handle or display name)."""
    height = screen_height(nodes)
    wanted = {handle.casefold()} | ({full_name.casefold()} if full_name else set())
    for n in ig(nodes):
        if n.center[1] < height * 0.2 and n.label and (
                n.label.strip().lstrip("@").casefold() in wanted
                or any(w and n.label.casefold().startswith(w) for w in wanted)):
            return True
    return False


def has_history(nodes: list[Node], box: Node | None) -> bool:
    """Any earlier message bubble in the thread (ours or theirs)."""
    for n in ig(nodes):
        if n is box or not n.label:
            continue
        rid = n.rid.split("/")[-1]
        if any(part in rid for part in HISTORY_RIDS):
            return True
    return False


def as_dumped(text: str) -> str:
    """The text as the phone's XML dump shows it. The dump writes each UTF-16
    unit of a character outside the Basic Multilingual Plane (most emoji) as
    ".", so "phone 😄" reads "phone .." (measured on the A20e, 2026-11-23)."""
    return "".join(".." if ord(c) > 0xFFFF else c for c in text or "")


def _folded(text: str) -> str:
    return " ".join((text or "").split())


def typed_matches(have: str, want: str) -> bool:
    """The box holds exactly the message: read directly, or through the dump."""
    return _folded(have) in (_folded(want), _folded(as_dumped(want)))


def message_shown(nodes: list[Node], text: str, box: Node | None) -> bool:
    wants = {normalize(text).casefold(), _folded(as_dumped(text)).casefold()}
    for n in ig(nodes):
        if n is box or "edittext" in n.cls.lower() or not n.label:
            continue
        haves = (normalize(n.label).casefold(), _folded(n.label).casefold())
        for want in wants:
            head, tail = want[:40], want[-40:]
            if any((head and head in have) or (tail and tail in have) for have in haves):
                return True
    return False


class Sender:
    def __init__(self, galaxy: Galaxy, store: Store, account: str = ACCOUNT, restore: bool = True) -> None:
        self.g, self.store, self.account, self.restore = galaxy, store, account.casefold(), restore

    # plumbing

    async def screen(self) -> list[Node]:
        self._touch_lock()
        return await self.g._screen()

    def _touch_lock(self) -> None:
        """Keep the shared phone lock fresh during a long batch (it goes stale after 10 min)."""
        try:
            if self.g.lock_path.read_text().strip() == str(os.getpid()):
                os.utime(self.g.lock_path)
        except OSError:
            pass

    async def wait(self, seconds: float) -> None:
        end = time.monotonic() + seconds
        while (left := end - time.monotonic()) > 0:
            self._touch_lock()
            await asyncio.sleep(min(20.0, left))

    def save_screen(self, step: str, nodes: list[Node]) -> None:
        SCREENS_DIR.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%dT%H%M%S")
        rows = [{"label": n.label[:1200], "rid": n.rid.split("/")[-1], "cls": n.cls.split(".")[-1],
                 "click": n.clickable, "bounds": n.bounds} for n in nodes if n.package == INSTAGRAM]
        (SCREENS_DIR / f"{stamp}-{step}.json").write_text(json.dumps(rows, indent=0, ensure_ascii=False),
                                                          encoding="utf-8")
        for old in sorted(SCREENS_DIR.glob("*.json"))[:-60]:
            old.unlink(missing_ok=True)

    async def check(self, nodes: list[Node] | None = None) -> list[Node]:
        """Stop at a security/login screen or any pushback, before doing anything else."""
        stop = await self.g._stopped("instagram")
        if stop:
            raise Pushback(f"Instagram is showing a {stop.rsplit('.', 1)[-1]} screen")
        nodes = nodes if nodes is not None else await self.screen()
        why = pushback_on(nodes)
        if why:
            self.save_screen("pushback", nodes)
            self.store.pause(DM_PAUSE_S, why)
            self.g._pause("instagram", f"a notice: {why[:60]}")
            raise Pushback(f"Instagram said: {why}")
        return nodes

    # the account

    async def own_profile(self) -> tuple[str, Node | None, list[Node]]:
        """Open the app's own profile tab: (signed-in username or '', its title node, screen)."""
        await self.g._shell(f"am start --activity-clear-top -n {await self.g._launcher_component()}")
        await self.wait(4)
        nodes = await self.check()
        tab = next((n for n in ig(nodes) if n.rid.endswith("/profile_tab")), None)
        if tab is None:
            self.save_screen("no-profile-tab", nodes)
            raise ScreenProblem("the app's Profile tab is not on screen")
        await self.g._tap(tab)
        await self.wait(3)
        nodes = await self.check()
        if find_button(ig(nodes), *EDIT_PROFILE) is None:
            self.save_screen("own-profile", nodes)
            raise ScreenProblem("the own profile did not open (no Edit profile button)")
        title = account_title(nodes)
        return (title.label.strip().lstrip("@").casefold() if title else ""), title, nodes

    async def switch_to(self, username: str, title: Node | None, nodes: list[Node]) -> bool:
        """Own profile -> the title's account switcher -> that exact username. Taps nothing else."""
        target = clickable_at(ig(nodes), title) if title else None
        if target is None or title is None:
            return False
        await self.g._tap(target)
        await self.wait(2.5)
        sheet = await self.check()
        row = next((n for n in ig(sheet) if n.label.strip().casefold() == username
                    and n.center[1] > (title.bounds[3] + 20)), None)
        tap = clickable_at(ig(sheet), row) if row else None
        if tap is None or LOGIN_WORDS.search(tap.label):
            self.save_screen("switcher", sheet)
            await self.g._key("KEYCODE_BACK")
            return False
        await self.g._tap(tap)
        await self.wait(6)
        return True

    async def ensure_account(self) -> str:
        """Make @matboss_online the active account. Returns the account to go back to ('' = none)."""
        current, title, nodes = await self.own_profile()
        if current == self.account:
            return ""
        if not current:
            self.save_screen("own-profile-no-title", nodes)
            raise ScreenProblem("could not read the signed-in username")
        log.info("Instagram is on @%s; switching to @%s for the batch", current, self.account)
        if not await self.switch_to(self.account, title, nodes):
            raise AccountProblem(f"@{self.account} is not in the app's account switcher (the app is on "
                                 f"@{current}). Add it in the Instagram app on the phone.")
        now, _, _ = await self.own_profile()
        if now != self.account:
            raise AccountProblem(f"switching to @{self.account} did not take (still @{now or 'unknown'})")
        return current

    async def go_back_to(self, previous: str) -> None:
        if not previous or not self.restore:
            return
        try:
            current, title, nodes = await self.own_profile()
            if current != previous and await self.switch_to(previous, title, nodes):
                now, _, _ = await self.own_profile()
                log.info("Switched back to @%s%s", previous, "" if now == previous else f" (now @{now})")
        except (ScreenProblem, PhoneUnavailable) as err:
            log.warning("Could not switch back to @%s: %s", previous, err)

    def require_unpaused(self) -> None:
        """The email finder shares the phone: a challenge it meets while this
        batch waits for the phone pauses everything, and nothing goes on after it."""
        if self.g.phone_paused_for() or self.g.paused_for("instagram"):
            raise Paused(f"{DEVICE_NAME} was paused after a security check")

    async def online(self) -> bool:
        for host in ONLINE_HOSTS:
            if PING_OK.search(await self.g._shell(f"ping -c 2 -W 4 {host}", timeout=20)):
                return True
        return False

    async def require_online(self) -> None:
        """Raise Offline unless the phone has internet. Asked before a batch and
        again before any lead is skipped, held or failed, so a dropped hotspot
        never reads as "the account does not exist"."""
        if not await self.online():
            raise Offline(f"{DEVICE_NAME} has no internet connection")

    # one message

    async def open_thread(self, lead: Lead) -> tuple[list[Node], Node, str]:
        nodes: list[Node] = []
        for attempt in range(2):  # the golden rule: a profile gets two tries
            await self.g._input(f"am start -a android.intent.action.VIEW "
                                f"-d https://www.instagram.com/{lead.handle}/ -p {INSTAGRAM}")
            await self.wait(1)
            nodes = await self.g._until_profile_shown(lead.handle)
            await self.check(nodes)
            if instagram_profile_shown(nodes, lead.handle):
                break
            if attempt == 1:
                if user_not_found(nodes):
                    raise Skip("phone: Instagram says the account does not exist")
                self.save_screen("profile", nodes)
                raise ScreenProblem(f"@{lead.handle} did not open")
            await self.wait(2)
        await self.wait(1.5)
        nodes = await self.check()
        name = full_name_on_profile(nodes)
        button = profile_message_button(nodes)
        if button is None:
            self.save_screen("no-message-button", nodes)
            raise Held("phone: the profile has no Message button")
        await self.g._tap(button)
        box = None
        for _ in range(8):
            await self.wait(1.5)
            nodes = await self.check()
            refuses = recipient_refuses(nodes)
            if refuses:
                raise Skip(f"phone: {refuses}")
            box = composer(nodes)
            if box is not None:
                break
        if box is None:
            self.save_screen("no-composer", nodes)
            raise ScreenProblem("the message thread did not open")
        if not thread_is_with(nodes, lead.handle, name):
            self.save_screen("wrong-thread", nodes)
            raise ScreenProblem(f"the thread that opened is not @{lead.handle}'s")
        return nodes, box, name

    async def type_text(self, box: Node, text: str) -> None:
        ui = self.g._ui
        if ui is None:
            raise ScreenProblem("no UiAutomator connection to type with")
        selector = {"resourceId": box.rid} if box.rid else {"className": "android.widget.EditText",
                                                            "packageName": INSTAGRAM}
        await asyncio.to_thread(lambda: ui(**selector).set_text(text))

    async def read_box(self, box: Node) -> str | None:
        """The message box's text read directly (exact, emoji included), or None
        when that fails and only the XML dump's version is left."""
        ui = self.g._ui
        if ui is None:
            return None
        selector = {"resourceId": box.rid} if box.rid else {"className": "android.widget.EditText",
                                                            "packageName": INSTAGRAM}
        try:
            text = await asyncio.to_thread(lambda: ui(**selector).get_text())
        except Exception:  # noqa: BLE001 - the dump is the fallback
            return None
        text = text or ""
        return "" if COMPOSER_HINT.match(text.strip()) else text

    async def send(self, lead: Lead, text: str, dry_run: bool = False) -> str:
        """'sent', 'unverified' or 'probe-ok'; raises LookupError (skip), ScreenProblem, Pushback."""
        nodes, box, name = await self.open_thread(lead)
        if has_history(nodes, box):
            self.save_screen("history", nodes)
            raise Held("phone: the thread already has messages")
        if composer_text(box):
            raise ScreenProblem("the message box already holds text")
        if dry_run:
            log.info("probe @%s: thread open (%s), message box empty, nothing typed", lead.handle, name or "no name")
            return "probe-ok"
        await self.g._tap(box)
        await self.wait(1)
        await self.type_text(box, text)
        await self.wait(1.2)
        nodes = await self.check()
        box = composer(nodes)
        typed = None
        if box is not None:
            typed = await self.read_box(box)
            if typed is None:
                typed = composer_text(box)
        if box is None or not typed_matches(typed, text):
            self.save_screen("typed", nodes)
            if box is not None:
                try:
                    await self.type_text(box, "")
                except Exception:  # noqa: BLE001 - best effort; nothing was sent either way
                    pass
            raise ScreenProblem("the message box does not hold exactly the message")
        button = send_button(nodes)
        if button is None:
            self.save_screen("no-send", nodes)
            await self.type_text(box, "")
            raise ScreenProblem("no Send button next to the message box")
        # From here on a crash must not lead to a second message.
        self.store.mark(lead.handle, "sending", "", message=text, account=self.account)
        await self.g._tap(button)
        await self.wait(3)
        nodes = await self.screen()
        why = pushback_on(nodes)
        if why:
            self.store.mark(lead.handle, "unverified", f"after Send: {why}", sent_at=time.time(),
                            sent_day=central_day())
            await self.check(nodes)  # records the pause and raises
        box = composer(nodes)
        if message_shown(nodes, text, box) and not composer_text(box):
            return "sent"
        self.save_screen("after-send", nodes)
        return "unverified"

    async def batch(self, leads: list[Lead], gap=IN_BATCH_GAP, dry_run: bool = False) -> tuple[int, int]:
        """Send to these leads with the phone held. Returns (sent, structural failures)."""
        sent = failures = 0
        if not await self.g.available():
            raise PhoneUnavailable(f"{DEVICE_NAME} is locked or off USB")
        # Queued: the email finder lets the phone go after its current step.
        if not await self.g._hold_phone(PHONE_WAIT_S, queue=True):
            raise PhoneBusy(f"{DEVICE_NAME} stayed busy with another process for {PHONE_WAIT_S // 60} min")
        previous = ""
        stopped = False  # after a challenge or notice the phone is left exactly as it is
        held_streak: list[str] = []
        try:
            self.require_unpaused()
            await self.require_online()
            previous = await self.ensure_account()
            for i, lead in enumerate(leads):
                if i:
                    await self.wait(random.uniform(*gap))
                    self.require_unpaused()
                try:
                    text = compose(lead)
                except ValueError as err:
                    self.store.mark(lead.handle, "skipped", str(err))
                    continue
                try:
                    result = await self.send(lead, text, dry_run=dry_run)
                except Held as err:
                    await self.require_online()
                    self.store.mark(lead.handle, "held", str(err))
                    log.info("@%s held: %s", lead.handle, err)
                    held_streak.append(str(err))
                    if len(held_streak) >= 3 and len(set(held_streak[-3:])) == 1:
                        raise ScreenProblem(f"three leads in a row: {err}. That looks like a misread screen; "
                                            f"see {SCREENS_DIR} and use `requeue`")
                    continue
                except Skip as err:
                    await self.require_online()
                    self.store.mark(lead.handle, "skipped", str(err))
                    log.info("@%s skipped: %s", lead.handle, err)
                    continue
                except ScreenProblem as err:
                    await self.require_online()
                    self.store.failed_attempt(lead.handle, f"screen: {err}")
                    failures += 1
                    log.warning("@%s not sent: %s", lead.handle, err)
                    if failures >= 2:
                        break
                    continue
                except Pushback:
                    stopped = True
                    raise
                finally:
                    if not stopped:
                        await self.g._leave("home")
                held_streak.clear()
                if result == "probe-ok":
                    continue
                self.store.mark(lead.handle, result, "" if result == "sent" else "Send tapped; the message was not seen",
                                sent_at=time.time(), sent_day=central_day(), message=text, account=self.account)
                sent += 1
                (log.info if result == "sent" else log.warning)(
                    "DM %s to @%s (%s, %s): %d today", result, lead.handle, lead.school, lead.city or "Texas",
                    self.store.sent_on(central_day()))
        except Pushback:
            stopped = True
            raise
        finally:
            try:
                if not stopped:
                    await self.go_back_to(previous)
                    await self.g._leave("home")
            finally:
                self.g._release_phone()
        return sent, failures


# ── the day ──────────────────────────────────────────────────────────────────

def next_gap(store: Store, daily: int, window: tuple[int, int], now: float | None = None) -> float:
    """Seconds to the next batch, spreading what is left of today's quota over the window."""
    left = daily - store.sent_on(central_day(now))
    secs = seconds_left_in_window(now, window)
    if left <= 0 or secs <= 0:
        return MIN_GAP
    batches = max(1.0, left / (sum(BATCH) / 2))
    return min(MAX_GAP, max(MIN_GAP, secs / batches * random.uniform(0.7, 1.2)))


def gate(store: Store, g: Galaxy, daily: int, window: tuple[int, int]) -> tuple[float, str]:
    pause = max(g.phone_paused_for(), g.paused_for("instagram"))
    if pause:
        return pause, "the phone or Instagram is paused after a security check or notice; clear it on the phone"
    if (left := store.dm_pause_left()):
        return left, f"DMs are paused after Instagram said: {store.get_meta('pause_why')}"
    if (wait := seconds_until_window(None, window)):
        return wait, "outside 09:00 to 21:00 Texas time"
    if store.sent_on(central_day()) >= daily:
        return seconds_until_next_day(None, window), f"today's {daily} are sent"
    if store.sent_since(time.time() - 3600) >= HOURLY:
        return 15 * 60, "the hourly cap is reached"
    return 0.0, ""


async def run(args: argparse.Namespace) -> None:
    store = Store()
    store.recover()
    adb = find_adb()
    if not adb:
        raise SystemExit("adb was not found")
    galaxy = Galaxy(Cache(CACHE_DIR / "engine.sqlite"), adb, args.serial)
    sender = Sender(galaxy, store, args.account, restore=not args.keep_account)
    window = (args.start_hour, args.end_hour)
    failures = 0
    sent_this_run = 0
    while True:
        if store.get_meta("synced_day") != central_day():
            try:
                sync(store, args.tab)
                store.set_meta("synced_day", central_day())
            except Exception as err:  # noqa: BLE001 - an old lead list still works
                log.warning("Sheet sync failed (%s); using the leads already loaded", err)
        wait, why = gate(store, galaxy, args.daily, window)
        if wait:
            log.info("Waiting %.1f h: %s.", wait / 3600, why)
            if not args.loop:
                return
            await asyncio.sleep(min(wait, 3600) + 5)
            continue
        size = random.randint(*BATCH)
        size = min(size, args.daily - store.sent_on(central_day()), HOURLY - store.sent_since(time.time() - 3600))
        if args.limit is not None:
            size = min(size, args.limit - sent_this_run)
            if size <= 0:
                log.info("Run limit of %d reached.", args.limit)
                return
        leads = store.next(max(1, size))
        if not leads:
            log.info("Every %s lead has been handled: %s", args.tab, store.counts())
            if not args.loop:
                return
            await asyncio.sleep(6 * 3600)
            store.set_meta("synced_day", "")
            continue
        try:
            sent, broken = await sender.batch(leads)
            sent_this_run += sent
            failures = failures + broken if not sent else broken
        except Pushback as err:
            log.warning("%s. DMs stop until it is cleared on the phone (and for at least 24 h after a notice).", err)
            if not args.loop:
                return
            continue
        except AccountProblem as err:
            log.error("%s", err)
            store.pause(6 * 3600, str(err))
            if not args.loop:
                return
            continue
        except Paused as err:
            log.warning("%s; the batch stopped there.", err)
            if not args.loop:
                return
            continue  # the gate waits out the pause
        except PhoneBusy as err:
            log.info("%s; trying again in 2 min.", err)
            if not args.loop:
                return
            await asyncio.sleep(120)
            continue
        except Offline as err:
            log.warning("%s; nothing is recorded against any lead. Trying again in 10 min.", err)
            if not args.loop:
                return
            await asyncio.sleep(10 * 60)
            continue
        except (ScreenProblem, PhoneUnavailable) as err:
            log.info("Batch not started: %s", err)
            failures += 1
        if failures >= MAX_FAILURES:
            log.error("%d steps in a row could not be verified; resting %d h. Screens are in %s",
                      failures, FAILURE_REST_S // 3600, SCREENS_DIR)
            if not args.loop:
                return
            await asyncio.sleep(FAILURE_REST_S)
            failures = 0
            continue
        gap = next_gap(store, args.daily, window) if failures == 0 else 10 * 60
        log.info("Next batch in %.0f min (%d sent today).", gap / 60, store.sent_on(central_day()))
        await asyncio.sleep(gap)


async def probe(args: argparse.Namespace) -> None:
    store = Store()
    galaxy = Galaxy(Cache(CACHE_DIR / "engine.sqlite"), find_adb() or "", args.serial)
    pause = max(galaxy.phone_paused_for(), galaxy.paused_for("instagram"))
    if pause:
        raise SystemExit(f"The phone is paused for another {pause / 3600:.1f} h; not touching it.")
    leads = [store.lead(r) for r in store.db.execute("select * from leads where handle=?", (args.handle,))] \
        if args.handle else store.next(1)
    if not leads:
        raise SystemExit("no lead to probe")
    sender = Sender(galaxy, store, args.account, restore=not args.keep_account)
    try:
        await sender.batch(leads[:1], dry_run=True)
    except (Offline, Paused, PhoneBusy) as err:
        raise SystemExit(str(err)) from None
    row = store.db.execute("select handle, state, why, attempts from leads where handle=?",
                           (leads[0].handle,)).fetchone()
    print(json.dumps(dict(row), indent=1))


def report(store: Store) -> None:
    rows = store.db.execute("select handle, school, city, state, why, sent_at, message from leads "
                            "where state in ('sent','unverified') order by sent_at").fetchall()
    with SENT_CSV.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Instagram", "School", "City", "State", "Note", "Sent (Texas time)", "Message"])
        for r in rows:
            w.writerow([f"@{r['handle']}", r["school"], r["city"], r["state"], r["why"],
                        central(r["sent_at"]).strftime("%Y-%m-%d %H:%M") if r["sent_at"] else "", r["message"]])
    print(json.dumps({"counts": store.counts(), "sent today (Texas)": store.sent_on(central_day()),
                      "paused for h": round(store.dm_pause_left() / 3600, 1), "sent list": str(SENT_CSV)}, indent=1))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("sync")
    s.add_argument("--tab", default=DEFAULT_TAB)
    p = sub.add_parser("preview")
    p.add_argument("--n", type=int, default=6)
    p.add_argument("--handle")
    for name in ("run", "probe"):
        r = sub.add_parser(name)
        r.add_argument("--account", default=ACCOUNT)
        r.add_argument("--keep-account", action="store_true", help="stay on the outreach account after a batch")
        r.add_argument("--serial", default=None)
        if name == "run":
            r.add_argument("--tab", default=DEFAULT_TAB)
            r.add_argument("--daily", type=int, default=DAILY)
            r.add_argument("--start-hour", type=int, default=WINDOW[0])
            r.add_argument("--end-hour", type=int, default=WINDOW[1])
            r.add_argument("--limit", type=int, help="messages to send in this run")
            r.add_argument("--loop", action="store_true", help="keep going day after day")
        else:
            r.add_argument("--handle", help="the lead to probe (default: the next queued one)")
    sub.add_parser("report")
    q = sub.add_parser("requeue")
    q.add_argument("which", nargs="?", default="held", choices=("held", "failed"))
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):  # messages carry emoji; the console is cp1252
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=[
        logging.StreamHandler(), logging.FileHandler(CACHE_DIR / "ig-dm.log", encoding="utf-8")])
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("uiautomator2").setLevel(logging.WARNING)

    if args.command == "run":
        if os.name == "nt":  # one sender at a time; the scheduled task relaunches as a watchdog
            import msvcrt
            lockfile = (CACHE_DIR / "ig-dm.lock").open("a+b")
            try:
                lockfile.seek(0)
                msvcrt.locking(lockfile.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                return
        asyncio.run(run(args))
        return
    if args.command == "probe":
        asyncio.run(probe(args))
        return
    store = Store()
    if args.command == "sync":
        print(json.dumps(sync(store, args.tab), indent=1))
        print(json.dumps(store.counts(), indent=1))
    elif args.command == "preview":
        rows = (store.db.execute("select * from leads where handle=?", (args.handle,)).fetchall() if args.handle
                else store.db.execute("select * from leads where state='queued' order by priority, reviews desc "
                                      "limit ?", (args.n,)).fetchall())
        for r in rows:
            lead = store.lead(r)
            print(f"── @{lead.handle} ({lead.school}, {lead.city or 'Texas'}; call: {lead.kind or 'none'})")
            print(compose(lead))
            print()
    elif args.command == "report":
        report(store)
    elif args.command == "requeue":
        print(json.dumps({"requeued": store.requeue(args.which), "counts": store.counts()}, indent=1))


if __name__ == "__main__":
    main()
