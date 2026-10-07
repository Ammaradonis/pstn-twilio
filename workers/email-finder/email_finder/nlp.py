"""spaCy: who runs the school, and whose email is this?

en_core_web_sm finds PERSON entities; an EntityRuler adds martial-arts
honorifics (Sensei, Sifu, Master, Professor, Shihan, Coach…) so
"Sensei John Smith" is one person, and a PhraseMatcher spots role words
(owner, founder, head instructor…). A person counts as the decision maker
when a role word sits in the same sentence or right next to the name.

Email context classifier:
  classify_email_context() recognises explicit language indicating whether
  a given email is surrounded by biz language ("contact us", "info@") or
  decision-maker language ("founded by", "owner", "sensei").  This is used
  as a context boost on top of the local-part classification.
"""

from __future__ import annotations

import contextlib
import functools
import re
import threading
from dataclasses import dataclass

import spacy
from spacy.language import Language
from spacy.matcher import PhraseMatcher

HONORIFICS = [
    "sensei", "sifu", "shifu", "master", "grandmaster", "grand master", "professor", "shihan",
    "kyoshi", "hanshi", "renshi", "sabumnim", "sabeomnim", "kru", "ajarn", "guro", "coach",
    "mr", "mrs", "ms", "miss", "dr", "sir", "shisochai", "geshi", "kancho",
    # Additional martial-arts specific
    "soke", "sihan", "sensei", "senpai", "roshi", "shidoshi", "godan", "shodan",
    # UK / international variants
    "chief", "head", "sempai", "nidan", "sandan", "yondan", "godan", "rokudan",
    "nanadan", "hachidan", "kudan", "judan",
]

# Role phrase → weight (1.0 = certainly decides on purchases).
ROLES: dict[str, float] = {
    # Ownership tier
    "owner": 1.0,
    "co-owner": 1.0,
    "co owner": 1.0,
    "proprietor": 1.0,
    "founder": 1.0,
    "co-founder": 1.0,
    "cofounder": 1.0,
    "ceo": 1.0,
    "managing director": 1.0,
    "director": 0.85,
    "general manager": 0.8,
    "school director": 1.0,
    "program director": 0.7,
    "principal": 0.9,
    # Martial-arts titles that indicate the person runs the school
    "head instructor": 0.9,
    "chief instructor": 0.9,
    "senior instructor": 0.6,
    "lead instructor": 0.7,
    "head coach": 0.85,
    "head professor": 0.9,
    "chief instructor and owner": 1.0,
    "head sensei": 0.9,
    "chief sensei": 1.0,
    "head sifu": 0.9,
    "head master": 0.9,
    "grandmaster": 0.85,
    "grand master": 0.85,
    "shihan": 0.8,
    "kancho": 0.85,
    "soke": 0.9,
    "sihan": 0.8,
    # Club administration
    "club secretary": 0.6,
    "club leader": 0.8,
    "club chairman": 0.7,
    "chairman": 0.7,
    "manager": 0.6,
    # Lower-tier instructors
    "instructor": 0.45,
    "coach": 0.4,
    "teacher": 0.35,
    "assistant instructor": 0.2,
    "junior instructor": 0.2,
    "receptionist": 0.05,
    "front desk": 0.05,
    "program manager": 0.5,
    # UK associations
    "chief instructor": 0.9,
    "technical director": 0.85,
    "association director": 0.85,
    "regional director": 0.75,
    # ATA specific
    "certified instructor": 0.6,
    "black belt instructor": 0.7,
    # Belt / rank indicators (the highest-ranked person typically owns the school)
    "black belt instructor": 0.7,
    "4th degree black belt": 0.6,
    "5th degree black belt": 0.7,
    "6th degree black belt": 0.75,
    "7th degree black belt": 0.8,
    "8th degree black belt": 0.85,
    "9th degree black belt": 0.9,
    "10th degree black belt": 0.95,
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
    r"^(owner|owners|founder|co-?founder|director|ceo|boss|headcoach|headinstructor|chiefinstructor|"
    r"sensei|sifu|master|professor|shihan|principal|manager|gm|kancho|soke|sihan|senpai|"
    r"grandmaster|grandmaster|kru|guro|ajarn|headsensei|chiefsensei|headsifu|headmaster|"
    r"shidoshi|hanshi|kyoshi|renshi|sabumnim|sabeomnim|schooldirector|programdirector)([._-]?\w*)?$"
)

# Context phrases that indicate a biz inbox (lower decision-maker confidence)
BIZ_CONTEXT = re.compile(
    r"\b(contact us|general enqui|general inq|information request|our team|front desk|"
    r"reception|booking|appointments|class enqui|info@|hello@|admin@|"
    r"for more information|reach us at|get in touch|send us a message)\b",
    re.I,
)
# Context phrases that indicate a decision-maker inbox (higher confidence)
DM_CONTEXT = re.compile(
    r"\b(founded by|owned by|owner|co-?owner|founder|co-?founder|head instructor|chief instructor|"
    r"school director|program director|sensei|sifu|master|shihan|grand master|kancho|"
    r"proprietor|managing director|principal|head coach|head sensei|chief sensei|"
    r"hanshi|kyoshi|renshi|shidoshi|sabumnim|soke|sihan|grandmaster|"
    r"operated by|run by|established by|created by|started by)\b",
    re.I,
)

# ── Context score adjustment ─────────────────────────────────────────────────

def context_score_delta(context: str) -> int:
    """Return a score adjustment (+/-) based on email surrounding context.

    Positive = email is more likely to belong to the decision maker.
    Negative = email is more likely to be a generic inbox.
    """
    classification = classify_email_context(context)
    if classification == "decision-maker":
        return 12
    if classification == "business":
        return -5
    return 0


@dataclass
class Person:
    name: str
    role: str | None
    weight: float  # role weight; 0 when no role found


@functools.lru_cache(maxsize=1)
def nlp() -> Language:
    model = spacy.load("en_core_web_sm", disable=["lemmatizer"])
    ruler = model.add_pipe("entity_ruler", before="ner", config={"overwrite_ents": True})
    # Honorific patterns: "Sensei John Smith", "Master Jane Doe", etc.
    honorific_tokens = list({h.split()[-1] for h in HONORIFICS})
    title = [{"LOWER": {"IN": honorific_tokens}}, {"IS_PUNCT": True, "OP": "?"}]
    name = [{"IS_TITLE": True, "IS_STOP": False, "LENGTH": {">=": 2}}] * 2
    ruler.add_patterns(
        [
            {"label": "PERSON", "pattern": title + name},
            {"label": "PERSON", "pattern": title + name[:1] + [{"IS_TITLE": True, "OP": "?"}] + name[:1]},
            # "Shihan Steve Williams" etc.
            {"label": "PERSON", "pattern": [{"LOWER": {"IN": ["shihan", "kancho", "soke", "sihan", "kru", "guro"]}}] + name},
        ]
    )
    return model


@functools.lru_cache(maxsize=1)
def role_matcher() -> PhraseMatcher:
    matcher = PhraseMatcher(nlp().vocab, attr="LOWER")
    matcher.add("ROLE", [nlp().make_doc(r) for r in ROLES])
    return matcher


@functools.lru_cache(maxsize=1)
def _role_weights() -> dict[tuple[str, ...], float]:
    """ROLES keyed by lowercase tokens, the way role_matcher compares them, so a
    match on "co - founder" in page text finds the "co-founder" weight."""
    return {tuple(t.lower_ for t in nlp().make_doc(r)): w for r, w in ROLES.items()}


ROLE_WORDS = {
    "owner", "founder", "instructor", "coach", "president", "vice", "head", "chief", "senior",
    "director", "manager", "principal", "secretary", "chairman", "treasurer", "assistant", "lead",
    "sensei", "sifu", "master", "professor", "grandmaster", "shihan", "kyoshi", "renshi", "hanshi",
    "soke", "kancho", "sihan", "kru", "guro", "ajarn",
}

# Founders of styles, legends and famous fighters named on many school sites.
FAMOUS = {
    "jigoro kano", "eddie bravo", "bruce lee", "gichin funakoshi", "morihei ueshiba",
    "helio gracie", "carlos gracie", "rorion gracie", "rickson gracie", "royce gracie",
    "carlos gracie jr", "mas oyama", "masutatsu oyama", "choi hong hi", "imi lichtenfeld",
    "imi sde-or", "ip man", "yip man", "chojun miyagi", "kenwa mabuni", "hironori otsuka",
    "gogen yamaguchi", "chuck norris", "jhoon rhee", "haeng ung lee", "ed parker",
    "dan inosanto", "mitsuyo maeda", "chito ryu", "tadashi nakamura", "tatsuo shimabuku",
    "anko itosu", "kanryo higaonna", "wong fei hung", "cheng man ching", "yang lu chan",
    "marcelo garcia", "john danaher", "gordon ryan", "conor mcgregor", "jon jones",
    "anderson silva", "georges st pierre",
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
    if not all(re.fullmatch(r"[A-Z][a-z][a-zA-Z''-]*\.?|[A-Z]\.", w) for w in words):
        return False
    if any(w.lower().strip(".") in ROLE_WORDS for w in words):
        return False
    bad = {
        "Martial", "Arts", "Academy", "Karate", "Taekwondo", "Jiu", "Jitsu", "Kung", "Fu",
        "Dojo", "Club", "School", "Studio", "Gym", "Fitness", "Kids", "Adults", "Classes",
        "Mixed", "Muay", "Thai", "Boxing", "Kickboxing", "Krav", "Maga", "Judo", "Black",
        "Belt", "Contact", "Privacy", "Policy", "Terms", "Read", "More", "Free", "Trial",
        "Book", "Now", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
        "Sunday", "Street", "Road", "Avenue", "Brazilian", "Japanese", "Korean", "Chinese",
        "Gracie", "Barra", "Tae", "Kwon", "Do", "Wing", "Chun", "Tai", "Chi", "Drive",
        "Parkway", "Highway", "Hwy", "Blvd", "Boulevard", "Court", "Plaza", "Suite",
        "Square", "Park", "Center", "Centre", "Aikido", "Kempo", "Kenpo", "Hapkido",
        "Capoeira", "Grappling", "Jiujitsu",
    }
    pieces = [p for w in words for p in re.split(r"[-'']", w.strip("."))]
    return not any(p in bad for p in pieces)


# One text at a time. The pipeline's vocabulary is shared, and the thread of a
# row that ran out of time keeps going after its coroutine is cancelled.
_people_lock = threading.Lock()


def people(text: str, limit_chars: int = 60_000) -> list[Person]:
    """People named in the text, with the strongest role found near each.

    Runs inside a spaCy memory zone. Without one, every new word of every page
    stayed in the vocabulary for the life of the worker (several MB per long
    page) until even a 1 MB array failed: "Unable to allocate 1.06 MiB for an
    array with shape (2907, 96) and data type float32".
    """
    with _people_lock:
        model = nlp()
        # Built outside the zone, so they outlive it.
        matcher, weights = role_matcher(), _role_weights()
        zone = model.memory_zone() if hasattr(model, "memory_zone") else contextlib.nullcontext()
        with zone:
            # Only plain strings leave the zone: the Doc is freed with it.
            return _people(model(text[:limit_chars]), matcher, weights)


def _people(doc, matcher: PhraseMatcher, role_weights: dict[tuple[str, ...], float]) -> list[Person]:
    matches = list(matcher(doc))
    # Prefer "assistant instructor" over its nested "instructor" role.
    roles = [(doc[s:e], role_weights[tuple(t.lower_ for t in doc[s:e])]) for _, s, e in matches
             if not any(s2 <= s and e <= e2 and e2 - s2 > e - s for _, s2, e2 in matches)]
    entities = [e for e in doc.ents if e.label_ == "PERSON"]
    # Only a role in the same sentence and within eight tokens can qualify.
    # Group once instead of repeatedly scanning every person for every role
    # across long team pages (the previous loop was quadratic in people).
    roles_by_sentence: dict[int, list] = {}
    for span, weight in roles:
        roles_by_sentence.setdefault(span.sent.start, []).append((span, weight))
    entities_by_sentence: dict[int, list] = {}
    for entity in entities:
        entities_by_sentence.setdefault(entity.sent.start, []).append(entity)
    found: dict[str, Person] = {}
    for ent in doc.ents:
        if ent.label_ != "PERSON":
            continue
        name = strip_honorific(ent.text.strip())
        if not _plausible(name) or name.lower().replace("-", " ") in FAMOUS or name.lower() in FAMOUS:
            continue
        best: tuple[str | None, float] = (None, 0.0)
        sentence = ent.sent.start
        for span, weight in roles_by_sentence.get(sentence, []):
            distance = min(abs(span.start - ent.end), abs(ent.start - span.end))
            if distance > 8:
                continue
            others = (e for e in entities_by_sentence[sentence] if e != ent)
            nearest = not any(min(abs(span.start - e.end), abs(e.start - span.end)) < distance for e in others)
            if nearest:
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


def classify_email_context(context: str) -> str:
    """Classify the text surrounding an email address.

    Returns:
      "decision-maker" — strong indicators the email belongs to the owner/head
      "business"       — generic info/contact language
      "unknown"        — not enough signal
    """
    if DM_CONTEXT.search(context):
        return "decision-maker"
    if BIZ_CONTEXT.search(context):
        return "business"
    return "unknown"
