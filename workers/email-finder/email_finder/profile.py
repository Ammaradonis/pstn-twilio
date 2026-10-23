"""What a school says about itself, as facts a note can be built from.

The Status cell gets three sentences after a call ("Tuesday is your kids karate
night", "you've been at it since 1998"), and these are the facts behind them:
the programmes, who teaches them, the timetable, what is coming up, what the
first class costs and how long the school has been running.

Everything here reads text the fetcher already has (its page cache) or a page
fetched for this row. spaCy (nlp.py) supplies the people; the rest is pattern
work. Precision matters far more than recall: a wrong detail in a sentence the
owner reads is worse than no detail at all, so a fact is only reported when the
words are actually there, and every list is short and specific.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass, field
from typing import Iterable, Sequence

from . import nlp

# Canonical style name -> how it is written on a school site. The first match
# wins per text, so a site that says "Kyokushin" is recorded as karate too.
STYLES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("karate", re.compile(
        r"\bkarate\b|\bshotokan\b|\bkyokushin\b|\bgoju[- ]?ryu\b|\bwado[- ]?ryu\b|"
        r"\bisshin[- ]?ryu\b|\bshito[- ]?ryu\b|\bchito[- ]?ryu\b|\bshukokai\b", re.I)),
    ("jiu jitsu", re.compile(
        r"\b(?:bjj|brazilian jiu[- ]?jitsu|jiu[- ]?jitsu|jiujitsu|gracie jiu|nogi|no-gi)\b", re.I)),
    ("judo", re.compile(r"\bjudo\b", re.I)),
    ("taekwondo", re.compile(r"\b(?:tae[- ]?kwon[- ]?do|taekwondo|w?tf|itf)\b", re.I)),
    ("aikido", re.compile(r"\baikido\b|\baiki[- ]?kai\b", re.I)),
    ("kung fu", re.compile(r"\bkung[- ]?fu\b|\bwing[- ]?chun\b|\bwing[- ]?tsun\b|\bchoy lay fut\b", re.I)),
    ("kickboxing", re.compile(r"\b(?:kick[- ]?boxing|kickboxing)\b", re.I)),
    ("muay thai", re.compile(r"\b(?:muay[- ]?thai|thai[- ]?boxing)\b", re.I)),
    ("boxing", re.compile(r"\bboxing\b(?! day)", re.I)),
    ("mma", re.compile(r"\b(?:mma|mixed martial arts?)\b", re.I)),
    ("wrestling", re.compile(r"\b(?:wrestling|freestyle wrestling)\b", re.I)),
    ("krav maga", re.compile(r"\bkrav[- ]?maga\b", re.I)),
    ("hapkido", re.compile(r"\bhapkido\b|\bkuksool\b", re.I)),
    ("kenpo", re.compile(r"\bke[nm]po\b", re.I)),
    ("tang soo do", re.compile(r"\btang[- ]?soo[- ]?do\b", re.I)),
    ("capoeira", re.compile(r"\bcapoeira\b", re.I)),
    ("tai chi", re.compile(r"\btai[- ]?chi\b|\btaiji\b", re.I)),
    ("eskrima", re.compile(r"\b(?:eskrima|arnis|kali|escrima)\b", re.I)),
    ("iaido", re.compile(r"\b(?:iaido|kendo|kenjutsu|iaijutsu)\b", re.I)),
    ("sambo", re.compile(r"\bsambo\b", re.I)),
    ("self defence", re.compile(r"\bself[- ]?defen[cs]e\b", re.I)),
    ("jujutsu", re.compile(r"\bjujutsu\b|\bjujitsu\b(?!.*brazilian)", re.I)),
)

# Audience word -> the phrase a sentence can use. Ordered so the most specific
# wins where a page mentions several.
AUDIENCES: tuple[tuple[str, str], ...] = (
    ("kids", r"\b(?:kids?|children|junior|juniors|little dragons|ninjas|cubs)\b"),
    ("teens", r"\b(?:teens?|teenagers?|youths?)\b"),
    ("adults", r"\badults?\b"),
    ("families", r"\bfamil(?:y|ies)\b"),
    ("women", r"\b(?:women|ladies|girls only)\b"),
    ("beginners", r"\b(?:beginners?|new starters?|never trained|start from scratch)\b"),
)

EVENTS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("gradings", re.compile(
        r"\b(?:belt (?:tests?|gradings?|exams?)|gradings?|grading tests?|promotion (?:test|ceremony)|"
        r"dan (?:test|grading)|kyu (?:test|grading))\b", re.I)),
    ("competitions", re.compile(
        r"\b(?:competitions?|tournaments?|championships?|nationals|regionals|kumite|"
        r"fight nights?|inter[- ]?club)\b", re.I)),
    ("seminars", re.compile(
        r"\b(?:seminars?|master ?class(?:es)?|guest instructor|workshops?|specialist (?:course|class))\b", re.I)),
    ("summer camps", re.compile(r"\b(?:summer camps?|holiday camps?|camps?)\b", re.I)),
    ("open days", re.compile(r"\b(?:open (?:day|house)|come and try|try[- ]?it day)\b", re.I)),
    ("birthday parties", re.compile(r"\b(?:birthday parties?|parties)\b", re.I)),
)

OFFERS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("a free trial class", re.compile(
        r"\bfree (?:trial|taster|trial class|trial lesson|introductory|first)\b(?: (?:class|lesson|session))?", re.I)),
    ("the first class free", re.compile(
        r"\bfirst (?:class|lesson|session) (?:is )?free\b|\bfirst one(?:'s| is)? free\b", re.I)),
    ("no joining fee", re.compile(r"\bno (?:joining|sign[- ]?up|registration|membership) fee\b", re.I)),
    ("a free uniform", re.compile(r"\bfree (?:gi|uniform|dobok)\b", re.I)),
    ("a family discount", re.compile(r"\b(?:family|sibling) discounts?\b", re.I)),
)

SINCE = (
    re.compile(r"\b(?:since|established(?: in)?|founded(?: in)?|started(?: in)?)\s+((?:19|20)\d{2})\b", re.I),
    re.compile(r"\b(?:over|more than|almost|nearly)\s+(\d{1,2})\s+years\b", re.I),
    re.compile(r"\b(\d{1,2})\s+years (?:of )?(?:experience|teaching|training|business)\b", re.I),
)

DAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")
_DAY_RE = re.compile(r"\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?s?\b", re.I)
_DAY_CANON = {
    "mon": "Monday", "tue": "Tuesday", "tues": "Tuesday", "wed": "Wednesday",
    "thu": "Thursday", "thur": "Thursday", "thurs": "Thursday", "fri": "Friday",
    "sat": "Saturday", "sun": "Sunday",
}
_TIME = r"\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.)?"
_RANGE_RE = re.compile(
    rf"({_TIME})\s*(?:-|–|—|to|until|till)\s*({_TIME})", re.I)
_DAY_RANGE_RE = re.compile(
    r"\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?s?"
    r"(?:\s*(?:-|–|—|to|through|&|and)\s*(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?s?)?\b",
    re.I)

# Titles kept in front of a name: "Sensei John Smith" reads like the school
# writes it, and the owner recognises it instantly.
TITLES = ("Sensei", "Sifu", "Shifu", "Master", "Coach", "Professor", "Shihan", "Kancho", "Shidoshi", "Senpai")

MAX_PROGRAMS = 5
MAX_INSTRUCTORS = 4
MAX_EVENTS = 4
MAX_HOURS = 4
MAX_DAYS = 4
MAX_TIMES = 3
MAX_OFFERS = 3
MAX_STYLES = 4
MAX_AUDIENCES = 3
MAX_SOURCES = 6
MIN_INSTRUCTOR_WEIGHT = 0.4
SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+|\n+")
# A day name alone is only evidence when it sits next to a class word.
_CLASS_WORD = re.compile(r"\b(?:class(?:es)?|lessons?|sessions?|training|timetable|schedule|"
                         r"program(?:me)?s?|juniors?|beginners?|gradings?)\b", re.I)


def sentences(text: str) -> list[str]:
    return [s.strip() for s in SENTENCE_SPLIT.split(text) if s.strip()]


def _span(match: re.Match[str]) -> str | None:
    """A class-time range from a match, or None when it is not one.

    "5-6pm" and "9am-11am" and "17:00-18:30" are times; "ages 5-12", "15-57"
    and "20-25" are not, and a bare pair of numbers never counts."""
    raw = match.group(0)
    if not re.search(r"[ap]\.?m\.?", raw, re.I) and not (
        ":" in match.group(1) and ":" in match.group(2)
    ):
        return None
    start, end = _clock(match.group(1)), _clock(match.group(2))
    if not start or not end:
        return None
    return f"{start}–{end}"


def _norm_time(raw: str) -> str:
    """'5:00 PM' -> '5pm', '17:30' -> '17:30', '9' -> '9'."""
    value = raw.strip().lower().replace(".", "")
    value = re.sub(r"\s+", "", value)
    value = re.sub(r"^(\d{1,2}):00", r"\1", value)
    return value


def _clock(value: str) -> str | None:
    """The time as written, or None when it cannot be one.

    A timetable is full of other numbers ("ages 5-12", "15-57", phone fragments,
    prices). Only a clock time may become a sentence's "{time}"."""
    text = value.strip().lower().replace(" ", "")
    match = re.fullmatch(r"(\d{1,2})(?::([0-5]\d))?(am|pm)?", text)
    if not match:
        return None
    hour, minute, meridiem = int(match.group(1)), match.group(2), match.group(3)
    if meridiem:
        if not 1 <= hour <= 12:
            return None
    elif minute is not None:
        if hour > 23:
            return None
    elif not 1 <= hour <= 12:
        # Bare "15" is not a time a school means.
        return None
    return _norm_time(value)


def _clean(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip(" ,.;:-")


@dataclass
class Profile:
    """Short, specific facts about one school. Every list is empty when unknown."""
    programs: list[str] = field(default_factory=list)
    audiences: list[str] = field(default_factory=list)
    styles: list[str] = field(default_factory=list)
    instructors: list[str] = field(default_factory=list)
    events: list[str] = field(default_factory=list)
    hours: list[str] = field(default_factory=list)
    days: list[str] = field(default_factory=list)
    times: list[str] = field(default_factory=list)
    offers: list[str] = field(default_factory=list)
    since: str | None = None
    # Where the facts came from, for the Dial page's "why this sentence".
    sources: list[str] = field(default_factory=list)

    def facts(self) -> bool:
        """True when there is at least one detail worth a sentence."""
        return bool(self.programs or self.styles or self.instructors or self.events
                    or self.hours or self.offers or self.since)

    def to_dict(self) -> dict:
        out: dict = {}
        for name in ("programs", "audiences", "styles", "instructors", "events",
                     "hours", "days", "times", "offers", "sources"):
            values = getattr(self, name)
            if values:
                out[name] = values
        if self.since:
            out["since"] = self.since
        return out


def _count_patterns(text: str, patterns: Iterable[tuple[str, re.Pattern[str]]]) -> Counter:
    found: Counter = Counter()
    for name, pattern in patterns:
        hits = len(pattern.findall(text))
        if hits:
            found[name] += hits
    return found


def _audience_hits(text: str) -> Counter:
    return _count_patterns(text, ((name, re.compile(p, re.I)) for name, p in AUDIENCES))


def _programs(text: str, styles: Counter, audiences: Counter) -> Counter:
    """Style + audience pairs that share a sentence: "kids karate", "adult BJJ".

    A page that mentions kids somewhere and karate somewhere else proves
    nothing about a kids' karate class, so the two words have to appear in the
    same sentence to become a programme."""
    pairs: Counter = Counter()
    for sentence in sentences(text):
        style = next((name for name, pattern in STYLES if pattern.search(sentence)), None)
        if not style:
            continue
        audience = next((name for name in audiences
                         if re.search(dict(AUDIENCES)[name], sentence, re.I)), None)
        if audience:
            pairs[f"{audience} {style}"] += 1
    return pairs


def _instructors(text: str) -> Counter:
    """People the page gives a teaching role to, with their title when written."""
    found: Counter = Counter()
    for person in nlp.people(text, limit_chars=40_000):
        if person.weight < MIN_INSTRUCTOR_WEIGHT:
            continue
        name = person.name.strip()
        if not name:
            continue
        titled = name
        match = re.search(r"\b(" + "|".join(TITLES) + r")\b[\s,.:]+" + re.escape(name), text, re.I)
        if match:
            title = match.group(1)
            titled = f"{title[:1].upper()}{title[1:].lower()} {name}"
        elif person.role and person.role.lower() in ("head coach", "coach"):
            titled = f"Coach {name}"
        found[titled] += 1
    return found


def _schedule(text: str) -> tuple[list[str], list[str], list[str]]:
    """(hours, days, times) as written on a timetable.

    "Tuesdays and Thursdays 5-6pm" becomes hours "Tuesdays and Thursdays 5-6pm",
    days [Tuesday, Thursday], times ["5-6pm"]. A time with no day still counts
    as a time; a day with no time still counts as a day."""
    hours: list[str] = []
    days_seen: Counter = Counter()
    times: list[str] = []

    for match in _DAY_RANGE_RE.finditer(text):
        start, end = match.group(1), match.group(2)
        window = text[match.end():match.end() + 60]
        found = _RANGE_RE.search(window)
        span = _span(found) if found else None
        if span is None and not re.search(_TIME, window):
            # A day with no clock time is still a day the school teaches on.
            continue
        first = _DAY_CANON[start.lower()]
        days_seen[first] += 1
        if end:
            days_seen[_DAY_CANON[end.lower()]] += 1
            label = f"{first}s and {_DAY_CANON[end.lower()]}s"
        else:
            label = f"{first}s"
        if span:
            times.append(span)
            hours.append(f"{label} {span}")
        else:
            hours.append(label)

    for match in _RANGE_RE.finditer(text):
        span = _span(match)
        if span and span not in times:
            times.append(span)

    if not days_seen:
        # "Saturdays are for beginners" names no time, but it is still the day
        # the school runs classes. Only a day next to a class word counts.
        for match in _DAY_RE.finditer(text):
            window = text[max(0, match.start() - 40):match.end() + 40]
            if _CLASS_WORD.search(window):
                days_seen[_DAY_CANON[match.group(1).lower()]] += 1

    return _dedupe(hours)[:MAX_HOURS], [d for d, _ in days_seen.most_common(MAX_DAYS)], _dedupe(times)[:MAX_TIMES]


def _dedupe(values: Iterable[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        key = value.lower()
        if key and key not in seen:
            seen.add(key)
            out.append(value)
    return out


def extract(rows: Sequence[tuple[str, str]], *, title: str = "", category: str = "") -> Profile:
    """Facts from (url, visible text) pairs, merged across a school's pages."""
    profile = Profile()
    styles: Counter = Counter()
    audiences: Counter = Counter()
    programs: Counter = Counter()
    instructors: Counter = Counter()
    events: Counter = Counter()
    offers: Counter = Counter()
    hours: list[str] = []
    days: Counter = Counter()
    times: list[str] = []
    since: str | None = None

    for url, text in rows:
        if not text or not text.strip():
            continue
        body = text[:120_000]
        page_styles = _count_patterns(body, STYLES)
        page_audiences = _audience_hits(body)
        styles.update(page_styles)
        audiences.update(page_audiences)
        programs.update(_programs(body, page_styles, page_audiences))
        instructors.update(_instructors(body))
        events.update(_count_patterns(body, EVENTS))
        offers.update(_count_patterns(body, OFFERS))
        page_hours, page_days, page_times = _schedule(body)
        hours.extend(page_hours)
        days.update({d: 1 for d in page_days})
        times.extend(page_times)
        if since is None:
            for pattern in SINCE:
                found = pattern.search(body)
                if found:
                    value = found.group(1)
                    since = value if len(value) == 4 else f"{value} years"
                    break
        profile.sources.append(url)

        # The sheet's own category ("Karate") is a fact even when the page
        # never names the style.
        if category and not page_styles:
            for name, pattern in STYLES:
                if pattern.search(category):
                    styles[name] += 1
                    break

    profile.styles = [name for name, _ in styles.most_common(MAX_STYLES)]
    profile.audiences = [name for name, _ in audiences.most_common(MAX_AUDIENCES)]
    if not profile.styles:
        # A page that only ever says "martial arts" (a franchise welcome page, an
        # ATA/Ninja school with no style word) still gives a sentence a subject.
        # It is never counted against a real style: this only runs when none was
        # found, so "karate" is not replaced by the generic name.
        if any(re.search(r"\bmartial arts?\b|\bself-\s?defen[cs]e\b", text, re.I)
               for _, text in rows):
            profile.styles = ["martial arts"]
            styles["martial arts"] = 1
    # Paired programmes first ("kids karate"), then the bare styles, which are
    # still true sentences ("your karate night").
    paired = [name for name, _ in programs.most_common(MAX_PROGRAMS)]
    profile.programs = _dedupe(paired + profile.styles)[:MAX_PROGRAMS]
    profile.instructors = [name for name, _ in instructors.most_common(MAX_INSTRUCTORS)]
    profile.events = [name for name, _ in events.most_common(MAX_EVENTS)]
    profile.hours = _dedupe(hours)[:MAX_HOURS]
    profile.days = [day for day, _ in days.most_common(MAX_DAYS)]
    profile.times = _dedupe(times)[:MAX_TIMES]
    profile.offers = [name for name, _ in offers.most_common(MAX_OFFERS)]
    profile.since = since
    profile.sources = _dedupe(profile.sources)[:MAX_SOURCES]
    # A profile with nothing but sources is not a profile: the row has no facts
    # to write a sentence from, and the API should record the row as NOT_FOUND.
    if not profile.facts():
        return Profile()
    return profile
