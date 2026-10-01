"""spaCy: who runs the school, and whose email is this?

en_core_web_sm finds PERSON entities; an EntityRuler adds martial-arts
honorifics (Sensei, Sifu, Master, Professor, Shihan, Coach…) so
"Sensei John Smith" is one person, and a PhraseMatcher spots role words
(owner, founder, head instructor…). A person counts as the decision maker
when a role word sits in the same sentence or right next to the name.
"""

from __future__ import annotations

import functools
import re
from dataclasses import dataclass

import spacy
from spacy.language import Language
from spacy.matcher import PhraseMatcher

HONORIFICS = [
    "sensei", "sifu", "shifu", "master", "grandmaster", "grand master", "professor", "shihan",
    "kyoshi", "hanshi", "renshi", "sabumnim", "sabeomnim", "kru", "ajarn", "guro", "coach",
    "mr", "mrs", "ms", "miss", "dr", "sir",
]

# Role phrase → weight (1.0 = certainly decides on purchases).
ROLES: dict[str, float] = {
    "owner": 1.0, "co-owner": 1.0, "co owner": 1.0, "proprietor": 1.0, "founder": 1.0,
    "co-founder": 1.0, "cofounder": 1.0, "ceo": 1.0, "managing director": 1.0, "director": 0.85,
    "general manager": 0.8, "school director": 1.0, "program director": 0.7, "principal": 0.9,
    "head instructor": 0.9, "chief instructor": 0.9, "senior instructor": 0.6, "lead instructor": 0.7,
    "head coach": 0.85, "head professor": 0.9, "chief instructor and owner": 1.0, "club secretary": 0.6,
    "club leader": 0.8, "club chairman": 0.7, "chairman": 0.7, "manager": 0.6,
    "instructor": 0.45, "coach": 0.4, "teacher": 0.35, "assistant instructor": 0.2, "receptionist": 0.05,
    "front desk": 0.05, "program manager": 0.5,
}

GENERIC_LOCALS = {
    "info", "information", "contact", "contactus", "hello", "hi", "hey", "admin", "administrator",
    "office", "mail", "email", "enquiries", "enquiry", "inquiries", "inquiry", "sales", "support",
    "team", "help", "service", "services", "booking", "bookings", "book", "appointments", "reception",
    "frontdesk", "membership", "members", "join", "register", "registration", "classes", "training",
    "dojo", "gym", "academy", "club", "school", "studio", "noreply", "no-reply", "donotreply",
    "webmaster", "marketing", "accounts", "billing", "finance", "hr", "jobs", "careers", "media",
    "press", "events", "kids", "programs", "general", "welcome", "start", "trial", "freetrial",
}
DECISION_LOCALS = re.compile(
    r"^(owner|owners|founder|director|ceo|boss|headcoach|headinstructor|chiefinstructor|sensei|sifu|"
    r"master|professor|shihan|principal|manager|gm)([._-]?\w*)?$"
)


@dataclass
class Person:
    name: str
    role: str | None
    weight: float  # role weight; 0 when no role found


@functools.lru_cache(maxsize=1)
def nlp() -> Language:
    model = spacy.load("en_core_web_sm", disable=["lemmatizer"])
    ruler = model.add_pipe("entity_ruler", before="ner", config={"overwrite_ents": True})
    title = [{"LOWER": {"IN": [h.split()[-1] for h in HONORIFICS]}}, {"IS_PUNCT": True, "OP": "?"}]
    name = [{"IS_TITLE": True, "IS_STOP": False, "LENGTH": {">=": 2}}] * 2
    ruler.add_patterns(
        [
            {"label": "PERSON", "pattern": title + name},
            {"label": "PERSON", "pattern": title + name[:1] + [{"IS_TITLE": True, "OP": "?"}] + name[:1]},
        ]
    )
    return model


@functools.lru_cache(maxsize=1)
def role_matcher() -> PhraseMatcher:
    matcher = PhraseMatcher(nlp().vocab, attr="LOWER")
    matcher.add("ROLE", [nlp().make_doc(r) for r in ROLES])
    return matcher


ROLE_WORDS = {"owner", "founder", "instructor", "coach", "president", "vice", "head", "chief", "senior",
              "director", "manager", "principal", "secretary", "chairman", "treasurer", "assistant", "lead",
              "sensei", "sifu", "master", "professor", "grandmaster", "shihan", "kyoshi", "renshi", "hanshi"}


# Founders of styles, legends and famous fighters named on many school sites.
FAMOUS = {
    "jigoro kano", "eddie bravo", "bruce lee", "gichin funakoshi", "morihei ueshiba", "helio gracie",
    "carlos gracie", "rorion gracie", "rickson gracie", "royce gracie", "carlos gracie jr", "mas oyama",
    "masutatsu oyama", "choi hong hi", "imi lichtenfeld", "imi sde-or", "ip man", "yip man", "chojun miyagi",
    "kenwa mabuni", "hironori otsuka", "gogen yamaguchi", "chuck norris", "jhoon rhee", "haeng ung lee",
    "ed parker", "dan inosanto", "mitsuyo maeda", "chito ryu", "tadashi nakamura", "tatsuo shimabuku",
    "anko itosu", "kanryo higaonna", "wong fei hung", "cheng man ching", "yang lu chan", "marcelo garcia",
    "john danaher", "gordon ryan", "conor mcgregor", "jon jones", "anderson silva", "georges st pierre",
}


def strip_honorific(name: str) -> str:
    words = [w.strip(".,") for w in name.split()]
    while words and (words[0].lower() in HONORIFICS or words[0].lower() in ROLE_WORDS):
        words = words[1:]
    while words and words[-1].lower() in ROLE_WORDS:
        words = words[:-1]
    return " ".join(words)


def _plausible(name: str) -> bool:
    words = name.split()
    if not 2 <= len(words) <= 4:
        return False
    if not all(re.fullmatch(r"[A-Z][a-z][a-zA-Z'’-]*\.?|[A-Z]\.", w) for w in words):
        return False  # "Mark JR", "SENSEI BOB": not a clean First Last
    if any(w.lower().strip(".") in ROLE_WORDS for w in words):
        return False
    bad = {"Martial", "Arts", "Academy", "Karate", "Taekwondo", "Jiu", "Jitsu", "Kung", "Fu", "Dojo",
           "Club", "School", "Studio", "Gym", "Fitness", "Kids", "Adults", "Classes", "Mixed", "Muay",
           "Thai", "Boxing", "Kickboxing", "Krav", "Maga", "Judo", "Black", "Belt", "Contact", "Privacy",
           "Policy", "Terms", "Read", "More", "Free", "Trial", "Book", "Now", "Monday", "Tuesday",
           "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "Street", "Road", "Avenue",
           "Brazilian", "Japanese", "Korean", "Chinese", "Gracie", "Barra", "Tae", "Kwon", "Do", "Wing",
           "Chun", "Tai", "Chi", "Drive", "Parkway", "Highway", "Hwy", "Blvd", "Boulevard", "Court",
           "Plaza", "Suite", "Square", "Park", "Center", "Centre", "Aikido", "Kempo", "Kenpo", "Hapkido", "Capoeira", "Grappling", "Jiujitsu"}
    pieces = [p for w in words for p in re.split(r"[-’']", w.strip("."))]
    return not any(p in bad for p in pieces)


def people(text: str, limit_chars: int = 60_000) -> list[Person]:
    """People named in the text, with the strongest role found near each."""
    doc = nlp()(text[:limit_chars])
    roles = [(doc[s:e], ROLES[doc[s:e].text.lower()]) for _, s, e in role_matcher()(doc)]
    found: dict[str, Person] = {}
    for ent in doc.ents:
        if ent.label_ != "PERSON":
            continue
        name = strip_honorific(ent.text.strip())
        if not _plausible(name) or name.lower().replace("-", " ") in FAMOUS or name.lower() in FAMOUS:
            continue
        best: tuple[str | None, float] = (None, 0.0)
        for span, weight in roles:
            same_sentence = span.sent == ent.sent
            close = min(abs(span.start - ent.end), abs(ent.start - span.end)) <= 8
            if (same_sentence and close) or (close and abs(span.start - ent.start) <= 12):
                if weight > best[1]:
                    best = (span.text.lower(), weight)
        prev = found.get(name.lower())
        if prev is None or best[1] > prev.weight:
            found[name.lower()] = Person(name, best[0], best[1])
    return sorted(found.values(), key=lambda p: -p.weight)


def local_part_owner(local: str, persons: list[Person]) -> Person | None:
    """The person an email's local part names: john@, john.smith@, jsmith@, smithj@."""
    loc = re.sub(r"[^a-z]", "", local.lower())
    if not loc:
        return None
    for p in persons:
        parts = [re.sub(r"[^a-z]", "", w.lower()) for w in p.name.split()]
        first, last = parts[0], parts[-1]
        if len(first) < 2 or len(last) < 2:
            continue
        options = {
            first, last, first + last, last + first, first[0] + last, first + last[0],
            last + first[0], f"{first}{last[0]}", f"{first[0]}{last[0]}{last}",
        }
        if loc in options or (len(first) >= 4 and loc.startswith(first)) or (len(last) >= 4 and last in loc):
            return p
    return None


def classify_local(local: str) -> str:
    """generic | decision | personal | other"""
    loc = local.lower()
    base = re.sub(r"[\d._-]+$", "", loc)
    if base in GENERIC_LOCALS or any(loc.startswith(g + sep) for g in GENERIC_LOCALS for sep in ".-_"):
        return "generic"
    if DECISION_LOCALS.match(re.sub(r"[^a-z._-]", "", loc)):
        return "decision"
    if re.fullmatch(r"[a-z]+([._-]?[a-z]+)?\d{0,4}", loc) and len(base) >= 3:
        return "personal"
    return "other"
