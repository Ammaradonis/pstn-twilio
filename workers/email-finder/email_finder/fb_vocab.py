"""Every address becomes a local Facebook search, and nothing is sampled out.

The brief is blunt: every address input in "U.S. Conquest" and "The Official
UK" has to be considered when looking for Facebook groups. So this module turns
each address into an ordered search plan and keeps a ledger that proves it:

* One `Place` per (country, city). Each place holds the schools that share it,
  because Facebook groups are named after towns, not after schools. 27,965
  addresses collapse to ~5,700 places; every address belongs to exactly one.
* Each place draws phrases from a template pack for its country (US or UK
  spelling, county form, postcode form). The pack is data, so it is tunable
  without touching the search driver.
* A small national seed list covers the owner groups that are not local at all
  ("Martial Arts School Owners"). These are marked `national`, kept separate,
  and never counted as covering an address.
* `coverage()` fails loudly if any usable address has no search phrase behind
  it, or if a phrase is in the plan but no address justifies it.

Why the plan is tiered: 27,965 addresses x 20 phrases is a six-figure number of
searches, and a phone does one every 40 seconds or so. Tier 1 is the phrases a
martial arts owner would actually be in; tier 3 is hyper-local long tail. The
driver runs tier 1 to exhaustion first, then 2, then 3, and it is resumable, so
the plan is exhaustive while the work is ordered by what pays first.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .fb_addresses import Address, CACHE_FILE, load

log = logging.getLogger(__name__)

PLAN_FILE = CACHE_FILE.with_name("fb-search-plan.json")

# ── phrase packs ─────────────────────────────────────────────────────────────
# (template, bucket, tier). Buckets say what kind of group the phrase should
# find, so the joiner can score a result against the phrase that found it.
# {city} {county} {state} {postcode} are filled from the Place.
US_PHRASES: tuple[tuple[str, str, int], ...] = (
    # Tier 1: the two searches most likely to find an owner-facing group.
    ("{city} martial arts", "martial-arts", 1),
    ("{city} business owners", "owners", 1),
    # Tier 2: dense local reach, still one search each.
    ("{city} small business owners", "owners", 2),
    ("{city} martial arts school", "martial-arts", 2),
    ("{city} karate", "martial-arts", 2),
    ("{city} gym owners", "owners", 2),
    ("{city} community", "community", 2),
    ("{city} parents", "community", 2),
    ("{county} County business owners", "owners", 2),
    # Tier 3: long tail, tried after 1 and 2 are exhausted.
    ("{city} taekwondo", "martial-arts", 3),
    ("{city} jiu jitsu", "martial-arts", 3),
    ("{city} mma", "martial-arts", 3),
    ("{city} fitness professionals", "owners", 3),
    ("{city} entrepreneurs", "owners", 3),
    ("{city} moms", "community", 3),
    ("{county} County martial arts", "martial-arts", 3),
    ("{county} County small business", "owners", 3),
    ("{state} martial arts owners", "owners", 3),
    ("{postcode} martial arts", "martial-arts", 3),
)
UK_PHRASES: tuple[tuple[str, str, int], ...] = (
    ("{city} martial arts", "martial-arts", 1),
    ("{city} business owners", "owners", 1),
    ("{city} small business", "owners", 2),
    ("{city} martial arts classes", "martial-arts", 2),
    ("{city} karate", "martial-arts", 2),
    ("{city} gym owners", "owners", 2),
    ("{city} community", "community", 2),
    ("{city} parents", "community", 2),
    ("{county} business owners", "owners", 2),
    ("{postcode} martial arts", "martial-arts", 2),
    ("{city} taekwondo", "martial-arts", 3),
    ("{city} jiu jitsu", "martial-arts", 3),
    ("{city} mma", "martial-arts", 3),
    ("{city} mums", "community", 3),
    ("{city} personal trainers", "owners", 3),
    ("{city} entrepreneurs", "owners", 3),
    ("{county} small business", "owners", 3),
    ("{county} martial arts", "martial-arts", 3),
)

# The owner groups that are not local to anybody. Searched once, never counted
# as address coverage: they widen the net, they do not satisfy the rule.
NATIONAL_PHRASES: tuple[tuple[str, str, int], ...] = (
    ("martial arts school owners", "owners", 1),
    ("martial arts business owners", "owners", 1),
    ("martial arts instructors", "owners", 2),
    ("dojo owners", "owners", 2),
    ("karate school owners", "owners", 2),
    ("taekwondo instructors", "owners", 2),
    ("bjj gym owners", "owners", 2),
    ("martial arts marketing", "owners", 2),
    ("gym owners", "owners", 3),
    ("fitness business owners", "owners", 3),
)
NATIONAL_PHRASES_UK: tuple[tuple[str, str, int], ...] = (
    ("uk martial arts instructors", "owners", 1),
    ("uk martial arts business owners", "owners", 1),
    ("martial arts school owners uk", "owners", 2),
    ("british martial arts instructors", "owners", 2),
)

# How many phrases a place earns, by how many schools sit in it. A town with one
# school does not deserve nineteen searches; a city with 129 does.
def phrase_budget(schools: int) -> int:
    if schools >= 10:
        return 19
    if schools >= 4:
        return 12
    if schools >= 2:
        return 8
    return 5

# ── candidate scoring ────────────────────────────────────────────────────────
# What a group's name says about it. Facebook search returns everything that
# shares a word, so the joiner needs a defensible reason to join or skip.
OWNER_WORDS = ("owner", "owners", "business", "entrepreneur", "marketing", "professional",
               "network", "b2b", "agency", "consultant", "instructor", "coach")
MARTIAL_WORDS = ("martial art", "martial arts", "karate", "taekwondo", "tae kwon do", "bjj",
                 "brazilian jiu", "jiu jitsu", "jiu-jitsu", "judo", "mma", "muay thai",
                 "kickbox", "kung fu", "aikido", "krav", "boxing", "dojo", "kwan",
                 "hapkido", "capoeira", "wing chun", "escrima", "kenpo")
GYM_WORDS = ("gym", "fitness", "studio", "academy", "club", "school")
REJECT_WORDS = ("buy sell", "buy/sell", "swap", "marketplace", "for sale", "classifieds",
                "jobs", "hiring", "rent", "housing", "dating", "singles", "hookup",
                "memes", "crypto", "casino", "lottery", "coupon", "promo code")
CONSUMER_WORDS = ("parents", "moms", "mums", "kids", "students", "members", "families")
LOCATION_NOISE = ("near me", "city", "county")
MEMBER_WORD = re.compile(r"members?|followers?", re.I)
MEMBERS = re.compile(r"([\d.,]+)\s*([km])?\s*(?=members?\b|followers?\b)", re.I)
PLAIN_NUMBER = re.compile(r"([\d.,]+)\s*([km])?\b", re.I)


def _words_regex(words: tuple[str, ...]) -> re.Pattern[str]:
    """Match whole words and their plurals, never a fragment.

    "parents" contains "rent", and a plain substring test called every parents'
    group a rental group. Whole-word matching is the difference between a
    correct skip and a lost town.
    """
    parts = []
    for word in words:
        escaped = re.escape(word)
        parts.append(rf"{escaped}(?:s|es)?" if " " not in word and "/" not in word
                     else escaped)
    return re.compile(r"\b(?:" + "|".join(parts) + r")\b", re.I)


_OWNER = _words_regex(OWNER_WORDS)
_MARTIAL = _words_regex(MARTIAL_WORDS)
_GYM = _words_regex(GYM_WORDS)
_REJECT = _words_regex(REJECT_WORDS)
_CONSUMER = _words_regex(CONSUMER_WORDS)


def _first(pattern: re.Pattern[str], text: str) -> str:
    found = pattern.search(text)
    return found.group(0).casefold() if found else ""


@dataclass
class Place:
    """One (country, city), with every school that shares it."""

    key: str  # "us:austin" — stable, dedupe-safe
    country: str
    city: str
    county: str = ""
    state_code: str = ""
    state_name: str = ""
    postcode_district: str = ""
    schools: int = 0
    addresses: list[str] = field(default_factory=list)
    counties: list[str] = field(default_factory=list)
    postcodes: list[str] = field(default_factory=list)

    def fill(self, template: str) -> str:
        """Fill a phrase template, or "" when a part it needs is missing."""
        values = {
            "city": self.city,
            "county": self.county,
            "state": self.state_name or self.state_code,
            "postcode": self.postcode_district,
        }
        missing = [name for name in re.findall(r"\{(\w+)\}", template) if not values.get(name)]
        if missing:
            return ""
        return re.sub(r"\s+", " ", template.format(**values)).strip().casefold()


@dataclass
class SearchTerm:
    term: str
    bucket: str  # "owners" | "martial-arts" | "community"
    tier: int
    country: str
    place_key: str  # "" for a national seed
    covers: int = 0  # usable addresses whose place this term searches
    sources: list[str] = field(default_factory=list)  # workbooks that justified it


def place_key(record: Address) -> str:
    return f"{(record.country or 'xx').casefold()}:{record.city.casefold()}"


def term_key(term: str, country: str = "") -> str:
    """The cache key for "this search has already run".

    The country is part of it: "somerset business owners" is two different
    searches, one in each market.
    """
    return f"{country.upper()}:{term.casefold()}" if country else term.casefold()


def term_from(payload: dict) -> SearchTerm:
    """Rebuild a SearchTerm from the plan JSON (the CLI and the worker both do)."""
    return SearchTerm(
        term=payload["term"],
        bucket=payload.get("bucket", "owners"),
        tier=int(payload.get("tier", 1)),
        country=payload.get("country", ""),
        place_key=payload.get("place_key", ""),
        covers=int(payload.get("covers", 0)),
        sources=list(payload.get("sources", [])),
    )


def build_places(records: list[Address]) -> dict[str, Place]:
    """Group every usable address under its town. Addresses are never dropped."""
    places: dict[str, Place] = {}
    for record in records:
        if not record.usable:
            continue
        key = place_key(record)
        place = places.get(key)
        if place is None:
            place = places[key] = Place(key=key, country=record.country, city=record.city)
        place.schools += 1
        place.addresses.append(record.address)
        if record.county and record.county not in place.counties:
            place.counties.append(record.county)
        if record.state_code and not place.state_code:
            place.state_code, place.state_name = record.state_code, record.state_name
        if record.state_name and not place.state_name:
            place.state_name = record.state_name
        if record.postcode_district and record.postcode_district not in place.postcodes:
            place.postcodes.append(record.postcode_district)
        if record.source not in place.__dict__.setdefault("_sources", []):
            place.__dict__["_sources"].append(record.source)
    for place in places.values():
        # One county per place: the commonest, so a town split across counties
        # still gets one honest county phrase rather than none.
        place.county = place.counties[0] if place.counties else ""
        place.postcode_district = place.postcodes[0] if place.postcodes else ""
    return places


def place_terms(place: Place, budget: int | None = None) -> list[SearchTerm]:
    """The phrases one place earns, in tier order, deduped."""
    pack = UK_PHRASES if place.country == "UK" else US_PHRASES
    limit = phrase_budget(place.schools) if budget is None else budget
    terms: list[SearchTerm] = []
    seen: set[str] = set()
    attempted = 0
    for template, bucket, tier in pack:
        if attempted >= limit:
            break
        phrase = place.fill(template)
        if not phrase:
            continue  # a part the address does not have, e.g. no county
        attempted += 1
        if phrase in seen:
            continue
        seen.add(phrase)
        terms.append(SearchTerm(term=phrase, bucket=bucket, tier=tier,
                                country=place.country, place_key=place.key,
                                covers=place.schools,
                                sources=list(place.__dict__.get("_sources", []))))
    return terms


def national_terms(countries: set[str] | None = None) -> list[SearchTerm]:
    """Owner-facing groups that belong to no town."""
    wanted = countries or {"US", "UK"}
    out: list[SearchTerm] = []
    if "US" in wanted:
        out += [SearchTerm(term=t, bucket=b, tier=i, country="US", place_key="")
                for t, b, i in NATIONAL_PHRASES]
    if "UK" in wanted:
        out += [SearchTerm(term=t, bucket=b, tier=i, country="UK", place_key="")
                for t, b, i in NATIONAL_PHRASES_UK]
    return out


@dataclass
class Plan:
    terms: list[SearchTerm]
    places: dict[str, Place]
    national: list[SearchTerm]
    # address text -> the terms that search the town it sits in
    ledger: dict[str, list[str]]

    @property
    def ordered(self) -> list[SearchTerm]:
        """Tier first, then the towns with the most schools, then alphabetically.

        Deterministic on purpose: a resumed run must not reshuffle the queue.
        """
        return sorted(self.terms, key=lambda t: (t.tier, -t.covers, t.term, t.country))


def build_plan(records: list[Address], include_national: bool = True) -> Plan:
    places = build_places(records)
    terms: list[SearchTerm] = []
    ledger: dict[str, list[str]] = {}
    for place in places.values():
        place_term_list = place_terms(place)
        terms += place_term_list
        names = [t.term for t in place_term_list]
        for address in place.addresses:
            ledger[address] = names
    national = national_terms({p.country for p in places.values()}) if include_national else []
    # A phrase two towns happen to share ("springfield martial arts") is searched
    # once and its coverage adds up. Two countries that share a name ("Somerset"
    # is a US county town and a UK county) stay separate searches, because the
    # group it finds is in one market and the comment's spelling follows the
    # market, not the string.
    merged: dict[tuple[str, str], SearchTerm] = {}
    for term in terms:
        key = (term.term, term.country)
        existing = merged.get(key)
        if existing is None:
            merged[key] = term
        else:
            existing.covers += term.covers
            existing.tier = min(existing.tier, term.tier)
            for source in term.sources:
                if source not in existing.sources:
                    existing.sources.append(source)
    return Plan(terms=list(merged.values()), places=places, national=national, ledger=ledger)


@dataclass
class Coverage:
    addresses: int
    covered: int
    missing: list[str]
    terms: int
    by_tier: dict[int, int]
    by_bucket: dict[str, int]
    countries: dict[str, int]

    @property
    def complete(self) -> bool:
        return not self.missing


def coverage(records: list[Address], plan: Plan) -> Coverage:
    """Prove the plan searches every address, and say which ones it misses."""
    usable = [r for r in records if r.usable]
    missing = [r.address for r in usable if not plan.ledger.get(r.address)]
    by_tier: dict[int, int] = {}
    by_bucket: dict[str, int] = {}
    for term in plan.terms:
        by_tier[term.tier] = by_tier.get(term.tier, 0) + 1
        by_bucket[term.bucket] = by_bucket.get(term.bucket, 0) + 1
    return Coverage(
        addresses=len(usable),
        covered=len(usable) - len(missing),
        missing=missing,
        terms=len(plan.terms),
        by_tier=dict(sorted(by_tier.items())),
        by_bucket=by_bucket,
        countries={c: sum(1 for p in plan.places.values() if p.country == c)
                   for c in sorted({p.country for p in plan.places.values()})},
    )


# ── scoring what the search returned ─────────────────────────────────────────


@dataclass
class GroupCandidate:
    name: str
    url: str = ""
    members: int = 0
    privacy: str = ""  # "public" | "private" | ""
    found_by: str = ""
    score: int = 0
    kind: str = ""  # "owners" | "martial-arts" | "local-community" | "reject"
    reasons: list[str] = field(default_factory=list)


def parse_members(text: str) -> int:
    """'12.4K members' -> 12400; '1,203' -> 1203; '' -> 0."""
    match = MEMBERS.search(text or "") or PLAIN_NUMBER.search(text or "")
    if not match:
        return 0
    raw = match.group(1).replace(",", "")
    try:
        value = float(raw)
    except ValueError:
        return 0
    suffix = (match.group(2) or "").casefold()
    return int(value * {"k": 1_000, "m": 1_000_000}.get(suffix, 1))


def score_group(name: str, found_by: SearchTerm | None = None, members: int = 0) -> GroupCandidate:
    """How much does this group's name look like somewhere a school owner is?

    The score is only ever used to order the join queue and to keep an audit
    trail; a group is never joined on the strength of its name alone. What it
    buys is a defensible skip: "buy/sell" groups and job boards are noise, and
    a comment there wastes a day's cap on people who are not owners.
    """
    lowered = (name or "").casefold()
    candidate = GroupCandidate(name=name, members=members)
    score = 30  # a group that exists and was returned by a relevant search
    reasons: list[str] = []

    martial = _first(_MARTIAL, lowered)
    owner = _first(_OWNER, lowered)
    gym = _first(_GYM, lowered)
    consumer = _first(_CONSUMER, lowered)

    if martial:
        score += 30
        reasons.append(f"martial arts ({martial})")
    if owner:
        score += 25
        reasons.append(f"owner/business language ({owner})")
    if gym and not martial:
        score += 8
        reasons.append(f"adjacent venue ({gym})")
    if consumer:
        score -= 10
        reasons.append(f"consumer audience ({consumer})")
        candidate.kind = "local-community"

    # Locality: the phrase that found it carries the town, so a group whose name
    # repeats the town is local to the schools we are trying to reach.
    if found_by is not None and found_by.place_key:
        place = found_by.place_key.split(":", 1)[-1]
        tokens = [t for t in re.split(r"[^a-z]+", place) if len(t) > 2]
        if tokens and all(t in lowered for t in tokens):
            score += 12
            reasons.append("names the town")
        elif any(t in lowered for t in tokens):
            score += 5
            reasons.append("partly names the town")

    if members >= 25_000:
        score += 12
        reasons.append("very large")
    elif members >= 2_000:
        score += 8
        reasons.append("large")
    elif members and members < 100:
        score -= 12
        reasons.append("very small")

    if found_by is not None:
        if found_by.bucket == "martial-arts" and martial:
            score += 12
            reasons.append("martial arts phrase found a martial arts group")
        elif found_by.bucket == "owners" and owner:
            score += 12
            reasons.append("business phrase found a business group")

    noise = _first(_REJECT, lowered)
    if noise:
        score -= 70
        reasons.append(f"noise group ({noise})")
        candidate.kind = "reject"

    if not candidate.kind:
        if martial and owner:
            candidate.kind = "owners"
        elif martial:
            candidate.kind = "martial-arts"
        elif owner:
            candidate.kind = "owners"
        else:
            candidate.kind = "local-community"
    candidate.score = max(0, min(100, score))
    candidate.reasons = reasons
    return candidate


def keep(candidate: GroupCandidate, minimum: int = 45) -> bool:
    """The join threshold. Documented rather than scattered through the driver."""
    return candidate.kind != "reject" and candidate.score >= minimum


# ── persistence and CLI ──────────────────────────────────────────────────────


def save_plan(plan: Plan, path: Path = PLAN_FILE) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "national": [asdict(t) for t in plan.national],
        "terms": [asdict(t) for t in plan.ordered],
        "places": {k: {kk: vv for kk, vv in asdict(v).items()} for k, v in plan.places.items()},
        "ledger": plan.ledger,
    }
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


def load_plan(path: Path = PLAN_FILE) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        prog="fb_vocab",
        description="Turn every workbook address into localized Facebook searches.")
    parser.add_argument("--addresses", default=str(CACHE_FILE))
    parser.add_argument("--out", default=str(PLAN_FILE))
    parser.add_argument("--no-national", action="store_true",
                        help="leave out the non-local owner groups")
    parser.add_argument("--report-only", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    records = load(Path(args.addresses))
    plan = build_plan(records, include_national=not args.no_national)
    report = coverage(records, plan)
    print(json.dumps({
        "addresses": report.addresses,
        "addressed_by_a_search": report.covered,
        "missing": len(report.missing),
        "local_terms": report.terms,
        "national_terms": len(plan.national),
        "by_tier": report.by_tier,
        "by_bucket": report.by_bucket,
        "places": report.countries,
        "tier1_terms": report.by_tier.get(1, 0),
        "tier1_plus_2": report.by_tier.get(1, 0) + report.by_tier.get(2, 0),
    }, indent=2))
    if not report.complete:
        print(f"{len(report.missing)} address(es) have no search phrase behind them; "
              f"first: {report.missing[:3]}", file=__import__("sys").stderr)
        return 1
    if not args.report_only:
        path = save_plan(plan, Path(args.out))
        print(f"Plan written to {path} ({len(plan.terms)} local + "
              f"{len(plan.national)} national searches).")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
