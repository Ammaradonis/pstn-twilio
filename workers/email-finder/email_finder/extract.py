"""Turn a page into email candidates (with surrounding text), links and forms.

Only reads what the page shows a visitor: mailto links, visible text
(including "name [at] domain [dot] com" spellings), and the structured
business data many sites publish (schema.org JSON-LD).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from urllib.parse import unquote, urljoin, urlsplit

from bs4 import BeautifulSoup

EMAIL_RE = re.compile(
    r"(?<![\w.+-])([a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]{1,63})*\.[a-z]{2,24})(?![\w-])",
    re.I,
)
# "john [at] dojo [dot] com", "john(at)dojo.com", "john AT dojo DOT co DOT uk"
SPELLED_RE = re.compile(
    r"\b([a-z0-9][a-z0-9._%+-]{0,63})\s*[\[\({<]?\s*(?:at|@)\s*[\]\)}>]\s*"
    r"([a-z0-9-]+(?:\s*(?:[\[\({<]\s*dot\s*[\]\)}>]|\.)\s*[a-z0-9-]+)+)",
    re.I,
)
SPELLED_PLAIN_RE = re.compile(
    r"\b([a-z0-9][a-z0-9._-]{1,40})\s+at\s+([a-z0-9-]{2,40}(?:\s+dot\s+[a-z]{2,10}){1,3})\b",
    re.I,
)
# "ruth.tkd AT aol.co.uk": a capitalised AT stands in for @ (the page tells visitors so).
SPELLED_CAPS_RE = re.compile(r"\b([A-Za-z0-9][A-Za-z0-9._%+-]{0,63})\s+AT\s+([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24})\b")
ASSET_TLDS = {"png", "jpg", "jpeg", "gif", "webp", "svg", "css", "js", "ico", "pdf", "mp4", "woff", "woff2"}

CONTACT_WORDS = re.compile(
    r"contact|get.?in.?touch|enquir|inquir|about|our.?team|team|staff|instructor|coach|"
    r"meet|owner|founder|our.?story|who.?we.?are|faq|privacy|imprint|legal|terms|location",
    re.I,
)
FORM_HOSTS = (
    "docs.google.com/forms",
    "forms.gle",
    "jotform.com",
    "typeform.com",
    "wufoo.com",
    "formstack.com",
    "cognitoforms.com",
    "forms.office.com",
    "hsforms.com",
    "tally.so",
)
CHALLENGE_RE = re.compile(
    r"(solve|answer|complete).{0,40}(reveal|show|see).{0,20}(e-?mail|address)|"
    r"(reveal|show).{0,15}e-?mail.{0,40}(captcha|challenge|sum|math)",
    re.I,
)


@dataclass
class Candidate:
    email: str
    source: str  # mailto | text | spelled | jsonld | snippet
    url: str
    context: str


@dataclass
class PageInfo:
    url: str
    text: str
    candidates: list[Candidate] = field(default_factory=list)
    links: list[tuple[str, str]] = field(default_factory=list)  # (absolute url, anchor text)
    social: set[str] = field(default_factory=set)
    forms: list[str] = field(default_factory=list)
    challenge: bool = False


def clean_email(raw: str) -> str | None:
    email = unquote(raw).strip().strip(".,;:'\"()<>[]").lower()
    email = email.split("?")[0]
    if email.startswith("mailto:"):
        email = email[7:]
    if not EMAIL_RE.fullmatch(email):
        return None
    tld = email.rsplit(".", 1)[-1]
    if tld in ASSET_TLDS or re.search(r"@\d+x\.", email):
        return None
    return email


def _context(text: str, start: int, end: int, width: int = 280) -> str:
    return re.sub(r"\s+", " ", text[max(0, start - width) : end + width]).strip()


def emails_in_text(text: str, url: str, source: str = "text") -> list[Candidate]:
    found: list[Candidate] = []
    for m in EMAIL_RE.finditer(text):
        email = clean_email(m.group(1))
        if email:
            found.append(Candidate(email, source, url, _context(text, m.start(), m.end())))
    for regex in (SPELLED_RE, SPELLED_PLAIN_RE, SPELLED_CAPS_RE):
        for m in regex.finditer(text):
            domain = re.sub(r"\s*(?:[\[\({<]\s*dot\s*[\]\)}>]|\s+dot\s+|\.)\s*", ".", m.group(2), flags=re.I)
            email = clean_email(f"{m.group(1)}@{domain}")
            if email:
                found.append(Candidate(email, "spelled", url, _context(text, m.start(), m.end())))
    return found


def parse_page(url: str, html: str) -> PageInfo:
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "noscript", "svg", "template"]):
        if tag.name == "script" and tag.get("type") == "application/ld+json":
            continue
        tag.decompose()

    jsonld_blocks = [t.get_text() for t in soup.find_all("script", type="application/ld+json")]
    for t in soup.find_all("script"):
        t.decompose()
    text = soup.get_text(" ", strip=True)
    info = PageInfo(url=url, text=text)

    # mailto links: the anchor's surroundings are the context.
    for a in soup.find_all("a", href=True):
        href = a["href"].strip()
        if href.lower().startswith("mailto:"):
            email = clean_email(href)
            if email:
                ctx = _block_text(a)
                info.candidates.append(Candidate(email, "mailto", url, ctx))
            continue
        absolute = urljoin(url, href)
        if not absolute.startswith("http"):
            continue
        anchor = a.get_text(" ", strip=True)[:80]
        info.links.append((absolute.split("#")[0], anchor))
        host = urlsplit(absolute).netloc.lower().removeprefix("www.").removeprefix("m.")
        if host in ("facebook.com", "instagram.com") and _is_profile(absolute):
            info.social.add(absolute.split("?")[0])
        if any(f in absolute for f in FORM_HOSTS):
            info.forms.append(absolute)

    info.candidates.extend(emails_in_text(text, url))

    for block in jsonld_blocks:
        for email in _jsonld_emails(block):
            info.candidates.append(Candidate(email, "jsonld", url, "structured business data"))

    # Contact forms on the page itself: a form with a message box.
    for form in soup.find_all("form"):
        if form.find("textarea") and (form.find("input", attrs={"type": "email"}) or "mail" in str(form).lower()):
            info.forms.append(url)
            break
    for frame in soup.find_all("iframe", src=True):
        src = urljoin(url, frame["src"])
        if any(f in src for f in FORM_HOSTS):
            info.forms.append(src)

    info.challenge = bool(CHALLENGE_RE.search(text))
    return info


def _block_text(node) -> str:
    """Text of the listing/row/paragraph around a link: in directories the
    school's name sits in a sibling cell, so climb until there is enough."""
    row = node.find_parent("tr")
    if row is not None:
        return re.sub(r"\s+", " ", row.get_text(" ", strip=True))[:600]
    current = node
    for _ in range(5):
        parent = current.parent
        if parent is None:
            break
        current = parent
        text = re.sub(r"\s+", " ", current.get_text(" ", strip=True))
        if len(text) >= 80:
            return text[:600]
    return re.sub(r"\s+", " ", current.get_text(" ", strip=True))[:600]


def _jsonld_emails(block: str) -> list[str]:
    try:
        data = json.loads(block)
    except (ValueError, TypeError):
        return []
    out: list[str] = []

    def walk(node: object) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if key.lower() == "email" and isinstance(value, str):
                    email = clean_email(value)
                    if email:
                        out.append(email)
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(data)
    return out


def _is_profile(url: str) -> bool:
    path = urlsplit(url).path.strip("/")
    if not path:
        return False
    first = path.split("/")[0].lower()
    return first not in {"sharer", "sharer.php", "share", "dialog", "plugins", "tr", "p", "reel", "explore", "hashtag"}


def contact_like_links(info: PageInfo, site_host: str, limit: int) -> list[str]:
    """Same-site links worth visiting for contact/owner details, best first."""
    scored: list[tuple[int, str]] = []
    seen: set[str] = set()
    for link, anchor in info.links:
        parts = urlsplit(link)
        if parts.netloc.lower().removeprefix("www.") != site_host or link in seen:
            continue
        if re.search(r"\.(pdf|jpg|jpeg|png|gif|zip|mp4|docx?)$", parts.path, re.I):
            continue
        seen.add(link)
        hay = f"{parts.path} {anchor}"
        if not CONTACT_WORDS.search(hay):
            continue
        score = 0
        if re.search(r"contact|enquir|inquir|get.?in.?touch", hay, re.I):
            score += 5
        if re.search(r"about|team|instructor|owner|founder|meet|staff|coach|story", hay, re.I):
            score += 3
        if re.search(r"privacy|legal|terms|imprint", hay, re.I):
            score += 1
        scored.append((score, link))
    scored.sort(key=lambda s: -s[0])
    return [link for _, link in scored[:limit]]
