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
import hashlib
import logging
import os
import random
import re
import time
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING, Iterable
from urllib.parse import quote

from .android import Node, PhoneUnavailable, STOP_SCREEN, CHALLENGE_SCREEN, find_button
from .fb_vocab import MEMBERS, MEMBER_WORD, GroupCandidate, SearchTerm, parse_members, \
    score_group, keep, term_key

if TYPE_CHECKING:  # pragma: no cover
    from .android import Galaxy

log = logging.getLogger(__name__)

FACEBOOK = "com.facebook.katana"
MESSENGER = "com.facebook.orca"

# Group pages open in the app from an https link (GroupsDeepLinkingAliasActivity),
# but `https://www.facebook.com/search/groups/?q=` resolves to Chrome: the app
# does not claim that URL, so a search sent that way never reached Facebook and
# every search came back with nothing. `fb://search` is claimed by the app and
# lands on its search screen with the query already typed, but the search still
# has to be submitted before any results exist.
SEARCH_URL = "fb://search?query={query}"
GROUP_URL = "https://www.facebook.com/groups/{group}"
MESSAGES_URL = "https://www.facebook.com/messages/"
SEARCH_SETTLE_S = 6.0
SEARCH_RESULTS_S = 3.0
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

# ── the membership-questions sheet ───────────────────────────────────────────
# Tapping Join on a group that screens its members opens a form instead of
# sending the request: a rules screen ("Agree"), or questions ("why do you want
# to join?", yes/no options, "I agree to the rules"). The worker used to read
# that as "the state did not change", mark the group failed for good and leave
# the sheet open on the phone: the next search then ran behind a modal, and each
# attempt had already spent a join from the day's allowance, so the queue
# drained into "daily join cap reached" with nothing joined.
FORM_TITLE = re.compile(
    r"membership questions?|answer (?:the |these )?(?:required )?questions?|"
    r"questions? (?:before|to) (?:join|joining)|before you join|"
    r"request to join|membership request|group rules|rules (?:of|for) (?:the|this) group", re.I)
FORM_SUBMIT = {"submit", "send request", "request to join", "submit answers", "answer"}
FORM_NEXT = {"next", "continue"}
FORM_AGREE = {"agree", "i agree", "accept", "i accept", "join group", "join anyway"}
FORM_CLOSE = {"close", "cancel", "not now", "back", "dismiss"}
FORM_DONE = re.compile(
    r"request (?:to join )?(?:was |has been )?(?:sent|submitted)|"
    r"your request (?:to join )?(?:was|has been) (?:sent|submitted|received)|"
    r"answer(?:s)? submitted|awaiting (?:admin |administrator )?approval|"
    r"pending (?:admin |administrator )?approval", re.I)
FORM_ERROR = re.compile(
    r"required|must (?:answer|select|choose|agree|respond)|answer (?:this|all|the)(?: required)? questions?|"
    r"select (?:an|one) option|choose (?:an|one) option|please (?:answer|select|agree|respond)", re.I)
FORM_AGREEMENT = re.compile(
    r"\b(?:agree|accept|read|rules|terms|polic(?:y|ies)|guidelines|consent|"
    r"over 18|18 or older|old enough)\b", re.I)
# A question that can be answered with Yes: "Do you agree...", "Have you read...".
# "Which town do you live in?" mentions living but is not a yes/no question.
FORM_YESNO = re.compile(r"^\s*(?:do|does|are|is|have|has|will|can|could|would|did)\b", re.I)
FORM_FOUND = re.compile(r"how did you (?:hear|find)|where did you (?:hear|find)|referr", re.I)
FORM_BUSINESS = re.compile(
    r"why (?:do|would) you|what brings you|tell us (?:a bit )?about|about (?:yourself|you)|"
    r"introduce yourself|what (?:do|is) your (?:business|trade|work)|your (?:business|trade)|"
    r"how did you (?:hear|find)|where did you (?:hear|find)|referr|what (?:are you )?(?:looking|hoping)|"
    r"interest(?:ed)? in|describe you|best describ|what (?:kind|type) of (?:business|member)|"
    r"who are you", re.I)
# Never guessed, whatever the question says: these are facts about the person
# that the worker does not have, and a wrong one is worse than a skipped join.
FORM_PERSONAL = re.compile(
    r"phone|telephone|mobile|\bcell\b|e ?mail|address|postcode|postal code|\bzip\b|"
    r"birth|age|medical|injur|allerg|gender|licen[cs]e|insurance|passport|tax", re.I)
FORM_YES = re.compile(r"^(?:yes|yep|yeah|sure|i agree|agree|accepted|accept|i accept|true|correct|"
                      r"i have read.*|have read.*|i understand.*|understood)$", re.I)
FORM_HINT = re.compile(
    r"^(?:answer|your answer|answers|write (?:an |your )?answer|type (?:an |your )?answer|"
    r"add an answer|write something|type something|add a response|response|write a response)$", re.I)
MAX_FORM_STEPS = 3

# What the worker says when a question asks why it wants in. Truthful, short,
# and about the business the account actually runs; FB_GROUPS_JOIN_ANSWER
# replaces it without a code change.
JOIN_ANSWER = ("I run a local business and would like to follow the group, learn from the "
               "posts and join the conversation where I can help.")

PRIVACY = re.compile(r"\b(public|private)\b", re.I)
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
# Facebook's search lands on an "All results" page whose filter chips read
# "Groups search results", "Pages search results", and so on. They look like
# cards to a geometry parser and are not groups, so they are excluded by name.
SEARCH_CHIP = re.compile(r"\bsearch results?\b", re.I)
GROUPS_CHIP = re.compile(r"^groups\b|groups search results", re.I)
# A group card's accessibility text is one string: "TNT Taekwondo,Public ·
# 275 members". Members, not followers: a Page on the same screen shows
# followers, and a Page is not a group.
GROUP_MEMBERS = re.compile(r"([\d.,]+)\s*([km])?\s*(?=members?\b)", re.I)
# A label that is nothing but the count ("12.4K members"), as opposed to a
# card that mentions one.
MEMBER_ONLY = re.compile(r"^[\d.,]+\s*[km]?\s*(?:members?|followers?)$", re.I)
# A card's metadata can also arrive as its own node ("Public \u00b7 6.2K members").
# It names no group, so it is not one.
LEADING_META = re.compile(r"^(?:public|private)\b|^[\d.,]+\s*[km]?\s*members?\b", re.I)
CARD_META = re.compile(
    r",\s*(?:public|private)\b|\s[·•]\s*(?:public|private)\b|"
    r",?\s*[\d.,]+\s*[km]?\s*members?\b|\s[·•]\s*\d+\+?\s*posts?\b", re.I)


def card_name(text: str) -> str:
    """The group's name out of a card's concatenated accessibility text."""
    cut = CARD_META.search(text or "")
    name = (text[: cut.start()] if cut else (text or "")).strip()
    return name.strip(" ,.|·•\uFFFC").strip()
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
    """The most word-like label in a row: a group name or a post's opening.

    A label that is *only* a member count is the count line; a card that merely
    mentions members is the card, and it is what carries the name.
    """
    candidates = [n.label.strip() for n in row
                  if not is_ui(n.label) and not MEMBER_ONLY.match(n.label.strip())
                  and not PRIVACY.fullmatch(n.label.strip())
                  and not SEARCH_CHIP.search(n.label)]
    if not candidates:
        return ""
    return max(candidates, key=lambda text: (len(text.split()), len(text)))


def groups_chip(nodes: list[Node]) -> Node | None:
    """The "Groups search results" filter on Facebook's All-results page."""
    for node in nodes:
        if node.clickable and node.center != (0, 0) and GROUPS_CHIP.search(node.label.strip()):
            return node
    return find_button(nodes, "Groups")


def _card_from_label(node: Node) -> GroupCandidate | None:
    """One result card, when Facebook has put it in a single label.

    That is what the app actually does ("TNT Taekwondo,Public \u00b7 275
    members"), and parsing per label rather than per band means two cards that
    sit close together cannot be merged into one and lost. A card qualifies by
    naming members: a Page on the same screen names followers, and a filter chip
    names neither.
    """
    label = node.label.strip()
    if not label or SEARCH_CHIP.search(label) or LEADING_META.match(label):
        return None
    members = GROUP_MEMBERS.search(label)
    if not members:
        return None
    name = card_name(label)
    if not name or len(name) < 3 or not name[0].isalnum():
        return None
    found = PRIVACY.search(label)
    candidate = score_group(name, None, parse_members(members.group(0)))
    candidate.privacy = found.group(1).casefold() if found else ""
    return candidate


def group_rows(nodes: list[Node]) -> list[GroupCandidate]:
    """Group search results -> candidates, with member counts when shown."""
    shown = visible(nodes)
    out: list[GroupCandidate] = []
    seen: set[str] = set()
    for node in shown:
        candidate = _card_from_label(node)
        if candidate is None or candidate.name.casefold() in seen:
            continue
        candidate.url = _url_hint([node])
        seen.add(candidate.name.casefold())
        out.append(candidate)
    if out:
        return out

    # Older layouts split one card across several nodes; fall back to reading
    # the band they sit in.
    height = screen_height(shown)
    for row in bands(shown, gap=18, max_height=height * 0.30):
        joined = " ".join(n.label for n in row if n.label)
        if not GROUP_MEMBERS.search(joined) or SEARCH_CHIP.search(joined):
            continue
        name = card_name(longest_text(row))
        if not name or len(name) < 3 or not name[0].isalnum() or name.casefold() in seen:
            continue
        found = PRIVACY.search(joined)
        candidate = score_group(name, None, parse_members(GROUP_MEMBERS.search(joined).group(0)))
        candidate.privacy = found.group(1).casefold() if found else ""
        candidate.url = _url_hint(row)
        seen.add(name.casefold())
        out.append(candidate)
    return out


def group_card(nodes: list[Node], name: str) -> Node | None:
    """The tappable node for a named card, so a group can be opened without a URL."""
    target = (name or "").casefold().strip()
    if not target:
        return None
    # A search field/suggestion containing the query is not a result card.
    for node in visible(nodes):
        candidate = _card_from_label(node)
        if candidate and candidate.name.casefold() == target and node.clickable:
            return node
    height = screen_height(visible(nodes))
    for row in bands(visible(nodes), gap=18, max_height=height * 0.30):
        joined = " ".join(n.label for n in row).casefold()
        if not GROUP_MEMBERS.search(joined):
            continue
        for node in row:
            if (node.clickable and node.center != (0, 0)
                    and card_name(node.label).casefold() == target):
                return node
    return None


def _url_hint(row: list[Node]) -> str:
    """A group URL if Facebook put one in the hierarchy, else ""."""
    for node in row:
        for text in (node.desc, node.text):
            found = re.search(r"facebook\.com/groups/([A-Za-z0-9._-]+)", text)
            if found:
                return GROUP_URL.format(group=found.group(1))
    return ""


def join_control(nodes: list[Node], group_name: str = "") -> tuple[Node | None, str]:
    """The Join button, or the state that says there is nothing to tap."""
    for node in visible(nodes):
        label = node.label.casefold().strip()
        if label in JOINED_LABELS:
            return None, label
    for node in visible(nodes):
        label = node.label.casefold().strip()
        named_join = bool(group_name) and label == f"join {group_name.casefold()} group"
        if (label in JOIN_LABELS or named_join) and node.clickable:
            return node, "joinable"
        if label in JOINED_LABELS:
            return None, label
    return None, ""


def group_page_open(nodes: list[Node], name: str) -> bool:
    """Is the phone already on this group's own page?

    A search for an exact group name often lands straight on the group instead of
    a result list: Facebook's "Join <name> group" button is the page's own, while
    a result card only ever says "Join". Reading that as a failed search is why
    the join stage kept giving up while the page it wanted was already open.
    """
    target = (name or "").casefold().strip()
    if not target:
        return False
    scoped = f"join {target} group"
    for node in visible(nodes):
        label = node.label.casefold().strip()
        if label == scoped or label in {"cancel request", "leave group"}:
            return True
    return False


@dataclass
class FormSheet:
    """What Facebook's membership-questions sheet is asking for."""

    title: str = ""
    questions: list[str] = field(default_factory=list)
    choices: list[Node] = field(default_factory=list)
    fields: list[Node] = field(default_factory=list)
    submit: Node | None = None
    next: Node | None = None
    agree: Node | None = None
    close: Node | None = None
    done: bool = False  # the request has been sent / is waiting for approval

    @property
    def question(self) -> str:
        """The sheet's question, longest first, for the answer and the log."""
        return max(self.questions, key=len, default="")[:400]


def join_answer_text() -> str:
    """What the worker writes when a question asks why it wants to join."""
    return (os.environ.get("FB_GROUPS_JOIN_ANSWER") or JOIN_ANSWER).strip()


def join_answer(question: str) -> str | None:
    """A truthful answer for one membership question, or None for a human.

    Rules and yes/no questions get "Yes"; openers about why the account wants in
    get the business line. Anything about the person's own phone, email, address,
    age or paperwork is never invented: those are exactly the fields Facebook's
    own policy says must be real, and a made-up one can get the account removed.
    """
    text = (question or "").strip()
    if not text:
        return None
    if FORM_PERSONAL.search(text):
        return None
    if FORM_AGREEMENT.search(text) and (FORM_YESNO.search(text) or text.endswith("?")):
        return "Yes"
    if FORM_FOUND.search(text):
        # True: the group came out of a search for local businesses.
        return "I found the group while searching Facebook for local businesses."
    if FORM_BUSINESS.search(text):
        return join_answer_text()
    return None


def positive_choice(choices: list[Node]) -> Node | None:
    """The "Yes"/"I agree" option of a yes/no question, if it offers one."""
    for node in choices:
        if FORM_YES.match(node.label.strip()):
            return node
    return None


BUSINESS_OPTION = re.compile(
    r"\b(?:business owner|business|owner|entrepreneur|founder|marketer|marketing|agency|"
    r"freelanc\w*|self[- ]employed|small business|advertis\w*|consultant)\b", re.I)


def business_choice(choices: list[Node]) -> Node | None:
    """The option that says what this account is, for "which describes you?".

    The account does run a business; picking that option is truthful. Anything
    else in a list of options ("Parent", "Coach", "Student") is a guess, so it is
    left alone and the sheet goes to the user.
    """
    for node in choices:
        if BUSINESS_OPTION.search(node.label):
            return node
    return None


def _sheet_swipe(width: int, height: int) -> "Gesture":
    """A short swipe inside a sheet: enough to scroll, not enough to dismiss it."""
    from .ambient import Gesture

    x = int(random.uniform(0.4, 0.6) * width)
    return Gesture(x, int(0.62 * height), x + random.randint(-6, 6),
                   int(0.34 * height), random.randint(240, 420), "sheet")


def form_done(nodes: Iterable[Node]) -> bool:
    """True when the screen says the request was sent or is waiting for an admin."""
    return any(FORM_DONE.search(node.label) for node in visible(nodes))


def _text_fields(nodes: Iterable[Node]) -> list[Node]:
    """Boxes a question's answer is typed into.

    An empty answer box has no label, and `visible()` keeps only labelled nodes,
    so this reads the raw tree: the resource id is what says "editable".
    """
    out: list[Node] = []
    for node in nodes:
        if not node.package.startswith(FACEBOOK):
            continue
        left, top, right, bottom = node.bounds
        if right <= left or bottom <= top:
            continue
        rid = node.rid.casefold()
        editable = (any(part in rid for part in ("edit", "textfield", "text_field", "answer"))
                    or bool(FORM_HINT.match(node.label.strip())))
        if editable and (node.clickable or "edit" in rid or FORM_HINT.match(node.label.strip())):
            out.append(node)
    return sorted(out, key=lambda n: (n.bounds[1], n.bounds[0]))


def read_form(nodes: Iterable[Node], group_name: str = "") -> FormSheet | None:
    """The membership-questions sheet on screen, or None when there is none.

    Facebook opens it instead of sending the request, in three shapes: a rules
    screen with one "Agree", a form of questions, or a "pending approval" page
    once the answers are in. The background group page stays in the tree behind
    the sheet, so the title and the sheet's own controls are what identify it -
    a page that merely says "Group rules" in its About section is not a form.
    """
    shown = visible(nodes)
    if not shown:
        return None
    if form_done(shown):
        return FormSheet(done=True)
    sheet = FormSheet()
    folded = [(node, node.label.strip()) for node in shown]
    sheet.close = find_button(shown, *FORM_CLOSE)
    sheet.submit = find_button(shown, *FORM_SUBMIT)
    sheet.next = find_button(shown, *FORM_NEXT)
    title = next((text for _, text in folded
                  if FORM_TITLE.search(text) and len(text) <= 120), "")
    # "Join group" belongs to the group page (and to a confirmation dialog, which
    # `join_dialog_confirm` answers); only "Agree"/"Accept" mean a rules screen.
    sheet.agree = find_button(shown, *(FORM_AGREE - {"join group"}))
    sheet.fields = _text_fields(nodes)
    buttons = FORM_SUBMIT | FORM_NEXT | FORM_AGREE | FORM_CLOSE | JOIN_LABELS | JOINED_LABELS
    sheet.choices = [
        node for node, text in folded
        if node.clickable and text.casefold() not in buttons and len(text) <= 80
        and not is_ui(text) and not text.endswith("?") and not MEMBER_ONLY.match(text)
        and not PRIVACY.fullmatch(text) and node.center != (0, 0)
    ]
    sheet.questions = [text for _, text in folded
                       if len(text) >= 10 and text != title and not is_ui(text)
                       and text.casefold() not in buttons and not MEMBER_ONLY.match(text)
                       and not SEARCH_CHIP.search(text)][:4]
    feed = any(text.casefold() in POST_MARKERS for _, text in folded)
    _, join_state = join_control(shown, group_name)
    is_form = bool(title and (sheet.submit or sheet.next or sheet.agree)) or bool(
        (sheet.submit or sheet.next) and (sheet.fields or sheet.choices)) or bool(
        # A long sheet can put Submit below the fold: no submit is visible, but
        # the title and an answer control are, and the page behind is not the feed.
        title and (sheet.fields or sheet.choices) and not feed and not join_state)
    if not is_form:
        return None
    sheet.title = title
    return sheet


def join_dialog_confirm(nodes: Iterable[Node]) -> Node | None:
    """The confirm button of a "Join group?" dialog, when one is open.

    A dialog is the one screen that shows a Join with a Cancel/Close next to it.
    Without that pair the page's own Join is all there is, and tapping it again
    would only be the same tap.
    """
    shown = visible(nodes)
    if not shown or find_button(shown, "cancel", "not now", "close", "dismiss") is None:
        return None
    for node in shown:
        if node.clickable and node.label.strip().casefold() in (JOIN_LABELS | FORM_AGREE):
            return node
    return None


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
        if ("edit" in node.rid.casefold()
                or (node.clickable and node.label.strip() == text.strip())):
            continue  # text still sitting in a composer is not publication
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
    join_attempts: int = 0
    retry_at: float = 0.0


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
        return [g for g in self._groups.values() if g.state == "joined"]

    def join_queue(self, now: float | None = None) -> list[GroupRecord]:
        now = time.time() if now is None else now
        # Retry only failures known to precede a Join tap. An uncertain tap is
        # reviewed, never automatically repeated - except the one that used to be
        # the questions sheet: that is answered now, and a page that says
        # "Joined"/"Cancel request" stops a second request anyway.
        retryable = {"the group could not be opened from its card",
                     "no Join control on the group page",
                     "Join tapped but the state did not change"}
        return sorted((g for g in self.all() if g.score >= 45
                       and (g.members or g.privacy or g.url)
                       and (g.join_attempts < 3 or g.state == "requested") and g.retry_at <= now
                       and (g.state in ("candidate", "requested") or
                            (g.state in ("failed", "refused") and g.note in retryable))),
                      # A request waiting for approval goes first. Rechecking it
                      # costs no join, and until it flips to "joined" the group
                      # can never be visited - but sorted by attempts alone it sat
                      # behind 1,500 fresh candidates and was never looked at again.
                      key=lambda g: (0 if g.state == "requested" else 1,
                                     g.join_attempts, -g.score))

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


def post_key(group: GroupRecord, author: str, text: str) -> str:
    """Stable across Python restarts, scoped to the group and author."""
    payload = "\0".join((group.url or group.name, author, " ".join(text.split())))
    return "fb-post:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


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
        """Wake the phone, clear whatever covers the app, then follow the link.

        A20e leaves the notification shade down after other work, and a link
        launched behind the shade reads as "the app never opened" on every
        screen dump. One wake and one Back costs a second and saves a search.
        """
        try:
            await self.phone._shell("input keyevent KEYCODE_WAKEUP")
            await self.phone._shell("input keyevent KEYCODE_BACK")
        except PhoneUnavailable:
            pass
        quoted = url.replace("'", "%27")
        await self.phone._input(
            f"am start -a android.intent.action.VIEW -d '{quoted}' -p {package}")

    async def _settle(self, seconds: float) -> None:
        """Wait in a way that yields to a lookup that wants the phone."""
        await self.phone._wait(seconds)

    async def _wait_for(self, check, waits=(2.0, 3.0, 4.0, 5.0)) -> list[Node]:
        """Read the screen until `check` holds, and return the last read.

        The A20e takes five to fifteen seconds to paint a Facebook page on this
        PC, so one read right after a tap sees the app's chrome and nothing else
        ("Back", "Search", "Show profile"): the join stage then reported "the
        card opened no Join control" for pages that were simply still loading.
        """
        nodes: list[Node] = []
        for wait in waits:
            await self._settle(wait)
            nodes = await self._screen()
            if check(nodes):
                return nodes
        return nodes

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

    async def _peek(self, action: str) -> tuple[bool, str]:
        """May this action run now? Reads the caps without spending a slot."""
        from .fb_engage import can_act, reserve_name

        day_name, hour_name = reserve_name(action)
        counts = {action: self.phone.cache.count(day_name), hour_name:
                  self.phone.cache.count(hour_name)}
        allowed, why = can_act(self.limits, self._session, action, counts)
        if not allowed:
            return allowed, why
        until = self.phone.cache.get("fb-action-cooldown", action) or 0
        if float(until) > time.time():
            return False, f"{action} cooldown"
        return True, ""

    async def _commit(self, action: str) -> tuple[bool, str]:
        """Spend one unit of an action's allowance on both counters.

        The counters live in the shared cache, so two processes, a restarted
        worker and a probe script all spend from the same daily allowance.
        """
        from .fb_engage import reserve_name

        day_name, hour_name = reserve_name(action)
        if not self.phone.cache.reserve(day_name, self.limits.cap(action, per_day=True)):
            return False, f"daily {action} cap reached"
        if not self.phone.cache.reserve(hour_name, self.limits.cap(action, per_day=False)):
            return False, f"hourly {action} cap reached"
        from .fb_engage import COOLDOWN
        lo, hi = COOLDOWN.get(action, (0, 0))
        if hi:
            self.phone.cache.set("fb-action-cooldown", action,
                                 time.time() + random.uniform(lo, hi), hi + 60)
        return True, ""

    async def _reserve(self, action: str) -> tuple[bool, str]:
        allowed, why = await self._peek(action)
        if not allowed:
            return False, why
        return await self._commit(action)

    async def _turn(self, app: str = "facebook") -> str:
        """None-equivalent '' when the phone may be used now, else why not."""
        from .ambient import in_quiet_hours

        if not self.limits.enabled:
            return "Facebook groups are switched off"
        if in_quiet_hours(self.limits.quiet_hours):
            return "quiet hours"
        if self.phone.phone_paused_for():
            return "the phone is paused after a security check"
        if self.phone.paused_for(app):
            return "the Facebook app is paused"
        if not await self.phone.available():
            return "the phone is unavailable"
        return await self._guard()

    # ── discovery ────────────────────────────────────────────────────────────

    async def _submit_search(self, term: str) -> bool:
        """Open the app's search and run the query. False when it never loaded.

        `fb://search` only opens the search screen with the query typed into the
        field; pressing Enter is what produces results, and the "Groups" tab is
        what narrows them to groups. Each step is verified before the next: a
        search that never loaded must not be recorded as run, or the plan would
        silently lose a town.
        """
        await self._open(SEARCH_URL.format(query=quote(term, safe="")))
        nodes: list[Node] = []
        # The A20e takes a few seconds to swap a busy Reels screen for the search
        # box, and declaring it "never loaded" costs the town its only search.
        for wait in (2.5, 2.5, 3.0, 4.0, 5.0):
            await self._settle(wait)
            nodes = await self._screen()
            query_shown = any(n.package.startswith(FACEBOOK) and n.clickable
                              and n.label.casefold().strip() == term.casefold().strip()
                              and n.bounds[1] < 250 for n in nodes)
            if query_shown and any(n.label.casefold() == "clear text" for n in nodes):
                break
        else:
            # Say what was on screen. A missing query field, the feed and a modal
            # all looked identical from here, and the join stage reported them as
            # "the group could not be opened" without a word about which it was.
            seen = [n.label[:40] for n in visible(nodes)[:5]] or ["nothing"]
            log.info("Facebook search %r: the search screen did not appear (%s)",
                     term, seen)
            return False
        if groups_chip(nodes) is None:
            await self.phone._key("KEYCODE_ENTER")
            await self._settle(SEARCH_RESULTS_S)
            nodes = await self._screen()
        chip = groups_chip(nodes)
        if chip is not None and not chip.selected:
            await self.phone._tap(chip)
            await self._settle(SEARCH_RESULTS_S)
        for _ in range(3):
            nodes = await self._screen()
            chip = groups_chip(nodes)
            empty = any(re.search(r"no results|couldn.t find any results", n.label, re.I)
                        for n in visible(nodes))
            if chip is not None and chip.selected and (group_rows(nodes) or empty):
                return True
            await self._settle(SEARCH_RESULTS_S)
        log.info("Group results did not verify for %r; keeping the search queued", term)
        return False

    async def search(self, term: SearchTerm) -> list[GroupCandidate]:
        """Run one search phrase and return the groups it shows."""
        allowed, why = await self._peek("search")
        if not allowed:
            log.info("Facebook search skipped (%s): %s", term.term, why)
            return []
        async with self.phone._lock:
            if not await self.phone._hold_phone(wait_s=10):
                return []
            try:
                why = await self._turn()
                if why:
                    log.info("Facebook search skipped (%s): %s", term.term, why)
                    return []
                if not await self._submit_search(term.term):
                    # Not counted, and not charged: the cap is for searches that
                    # reached Facebook, not for attempts that never got there.
                    log.info("Facebook search %r never loaded in the app; not counted",
                             term.term)
                    return []
                spent, why = await self._commit("search")
                if not spent:
                    log.info("Facebook search %r loaded but had no budget left: %s",
                             term.term, why)
                    return []
                found: list[GroupCandidate] = []
                seen: set[str] = set()
                for attempt in range(MAX_SEARCH_SCROLLS):
                    blocked = await self._guard()
                    if blocked:
                        log.info("Facebook search stopped: %s", blocked)
                        break
                    rows = group_rows(await self._screen())
                    for candidate in rows:
                        if candidate.name.casefold() in seen:
                            continue
                        seen.add(candidate.name.casefold())
                        scored = score_group(candidate.name, term, candidate.members)
                        scored.url = candidate.url
                        scored.privacy = candidate.privacy
                        scored.found_by = term.term
                        found.append(scored)
                    if not rows:
                        if attempt == 0:
                            # Results are fetched after the tab settles; one more
                            # read is cheaper than losing a whole town's search.
                            await self._settle(SEARCH_RESULTS_S)
                            continue
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
        terms = [t for t in terms
                 if not self.store.searched(term_key(t["term"], t.get("country", "")))]
        if limit is not None:
            # Top `limit` per tier, so a capped run still covers every tier.
            picked: list[dict] = []
            for tier in tiers:
                picked += [t for t in terms if t["tier"] == tier][:limit]
            terms = picked
        return terms

    async def _close_form(self) -> None:
        """Leave a question sheet the worker cannot answer.

        A sheet left open is what made every later search and join read the
        modal instead of the page, so this always runs on a refusal."""
        for _ in range(2):
            sheet = read_form(await self._screen())
            if sheet is None:
                return
            if sheet.close is not None:
                await self.phone._tap(sheet.close)
            else:
                await self.phone._key("KEYCODE_BACK")
            await self._settle(1.5)

    async def _fill_step(self, sheet: FormSheet, question: str) -> int:
        """Tap the answer a sheet allows. Returns how many were answered."""
        choice = positive_choice(sheet.choices)
        if choice is not None and (sheet.agree is not None or join_answer(question) == "Yes"):
            await self.phone._tap(choice)
            await self._settle(1.2)
            return 1
        # "Which of these describes you?" offers options rather than a box, and
        # "business owner" is what this account is.
        described = business_choice(sheet.choices)
        if described is not None and FORM_BUSINESS.search(question or ""):
            await self.phone._tap(described)
            await self._settle(1.2)
            return 1
        if sheet.agree is not None:
            await self.phone._tap(sheet.agree)
            await self._settle(1.2)
            return 1
        if sheet.fields:
            text = join_answer(question)
            if not text:
                return 0
            await self.phone._tap(sheet.fields[0])
            await self._settle(0.8)
            await self._enter_text(text)
            await self._settle(0.8)
            return 1
        return 0

    async def _answer_application(self, group_name: str, nodes: list[Node]) -> tuple[str, str]:
        """Fill in and send Facebook's membership questions.

        Returns ("requested", why) when a request went in, ("blocked", why) when a
        security check interrupted it, or ("refused", why) when the sheet asks
        something the worker cannot answer truthfully. The phone is never left on
        the sheet, and a question it cannot answer is handed to the review queue
        instead of being guessed at.
        """
        answered = 0
        question = ""
        scrolled = False
        answered_questions: set[str] = set()
        for _ in range(MAX_FORM_STEPS):
            sheet = read_form(nodes, group_name)
            if sheet is None:
                if answered:
                    return "requested", f"answered {answered} membership question(s)"
                return "refused", "the membership questions could not be read"
            if sheet.done:
                return "requested", f"answered {answered} membership question(s)" if answered \
                    else "the screen says the request was sent"
            question = sheet.question
            filled = 0
            if not question or question not in answered_questions:
                filled = await self._fill_step(sheet, question)
                if filled and question:
                    answered_questions.add(question)
            answered += filled
            button = sheet.next or sheet.submit
            if button is not None:
                await self.phone._tap(button)
                await self._settle(2.5)
            elif filled:
                # The tap itself was the action (an "Agree"): read the screen again.
                pass
            elif not scrolled:
                # A long question sheet puts Submit below the fold: scroll the
                # sheet once before giving up on it.
                scrolled = True
                try:
                    await self.phone._swipe(_sheet_swipe(*await self.phone._geometry()))
                except PhoneUnavailable:
                    break
                await self._settle(1.2)
                nodes = await self._screen()
                continue
            else:
                # Nothing to answer and nothing to press: this sheet needs a human.
                break
            nodes = await self._screen()
            blocked = await self._guard()
            if blocked:
                await self._close_form()
                return "blocked", blocked
            after = read_form(nodes, group_name)
            if after is None or after.done:
                return "requested", (f"answered {answered} membership question(s)" if answered
                                     else "the question sheet closed")
            if any(FORM_ERROR.search(node.label) for node in visible(nodes)):
                break
        await self._close_form()
        reason = f"membership questions need a human: {question[:160]}" if question \
            else "the membership questions did not go through"
        return "refused", reason

    async def _charge_join(self, record: GroupRecord) -> None:
        """Spend the join allowance for a request that really went out."""
        ok, why = await self._commit("join")
        if not ok:
            log.info("A request went to %s but the join allowance was spent (%s)",
                     record.name, why)

    async def _settle_join(self, record: GroupRecord, nodes: list[Node],
                           allow_confirm: bool = True) -> GroupRecord:
        """Read the screen after Join was tapped and record what happened.

        Four outcomes, and only one of them is a failure: the group's request
        went out, a membership-questions sheet is open (answered here), a
        confirmation dialog is open (answered once), or nothing changed.
        """
        sheet = read_form(nodes, record.name)
        if sheet is not None and not sheet.done:
            outcome, detail = await self._answer_application(record.name, nodes)
            if outcome == "requested":
                await self._charge_join(record)
                record.state = "requested"
                record.joined_at = time.time()
                record.note = detail
                log.info("Applied to %s (%s)", record.name, detail)
            elif outcome == "blocked":
                # A checkpoint or login wall arrived while answering: the group
                # is still worth joining once the phone is usable again.
                record.state = "candidate"
                record.note = detail
                record.retry_at = time.time() + 3600
            else:
                # Not the machine's call: hand it to the user and stop tapping.
                record.state = "refused"
                record.note = detail
                record.retry_at = time.time() + 7 * 86400
                self.store.review({"kind": "join-questions", "group": record.name,
                                   "why": detail})
            return record
        _, state = join_control(nodes, record.name)
        if state in JOINED_LABELS or form_done(nodes):
            await self._charge_join(record)
            record.state = "joined" if state == "joined" else "requested"
            record.joined_at = time.time()
            record.note = f"screen says {state}" if state else "the screen says the request was sent"
            log.info("Joined %s (%s)", record.name, record.note)
            return record
        if allow_confirm:
            confirm = join_dialog_confirm(nodes)
            if confirm is not None:
                await self.phone._tap(confirm)
                await self._settle(2.5)
                return await self._settle_join(record, await self._screen(), allow_confirm=False)
        record.state = "failed"
        record.note = "Join tapped but the state did not change"
        self.store.review({"kind": "join-unverified", "group": record.name, "why": record.note})
        return record

    async def join(self, candidate: GroupCandidate, country: str = "",
                   covers: int = 0) -> GroupRecord:
        """Open the group and press Join. Records what the screen says afterwards."""
        record = self.store.get(candidate.name) or GroupRecord(
            name=candidate.name, url=candidate.url, score=candidate.score,
            kind=candidate.kind, members=candidate.members, privacy=candidate.privacy,
            found_by=candidate.found_by, covers=covers, country=country)
        if record.state == "joined":
            return record
        pending = record.state == "requested"
        if record.state in ("failed", "refused") and record.note in {
                "the group could not be opened from its card", "no Join control on the group page"}:
            record.state = "candidate"
        if not pending:
            allowed, why = await self._peek("join")
            if not allowed:
                record.note = why
                return record
        async with self.phone._lock:
            # A join is capped at twelve a day and needs the phone for a minute;
            # ten seconds was never enough to wait out an Instagram slice, so the
            # stage spent the day reporting "busy" instead of joining.
            if not await self.phone._hold_phone(wait_s=90):
                # Say what happened. Returning the record untouched left its old
                # note in place, so a batch that lost the phone to the Instagram
                # lookups reported "daily join cap reached" for a join cap that
                # was not reached at all.
                record.note = "busy (another process is using the phone)"
                return record
            tapped = False
            try:
                why = await self._turn()
                if why:
                    record.note = why
                    return record
                record.retry_at = time.time() + 3600
                if candidate.url:
                    record.url = candidate.url
                    await self._open(candidate.url)
                elif not await self._open_group(candidate.name):
                    record.state = "requested" if pending else "failed"
                    record.note = "the group could not be opened from its card"
                    return record
                # The page is open: that is an attempt, and it is charged here
                # rather than before the navigation. A card the search could not
                # find is not an attempt against the group - charging it retired
                # groups after three unlucky searches that never tapped Join.
                if not pending:
                    record.join_attempts += 1
                await self._settle(PAGE_SETTLE_S)
                blocked = await self._guard()
                if blocked:
                    record.note = blocked
                    return record
                nodes = await self._wait_for(
                    lambda screen: bool(join_control(screen, record.name)[1])
                    or read_form(screen, record.name) is not None)
                button, state = join_control(nodes, record.name)
                if state == "joinable" and button is not None:
                    if pending:
                        # The Join control is back, so the request is gone
                        # (declined or withdrawn). Flip it to a candidate: left as
                        # "requested" it was re-read as pending forever, never
                        # tapped again, and never became a membership.
                        record.state = "candidate"
                        record.join_attempts = 0
                        record.note = "the pending request is gone; Join will be tapped again"
                        return record
                    # Peek, not reserve: a Join that opens a question sheet or does
                    # nothing has not spent a request, and charging it emptied the
                    # day's allowance one dead tap at a time.
                    allowed, why = await self._peek("join")
                    if not allowed:
                        record.note = why
                        return record
                    tapped = True
                    await self.phone._tap(button)
                    # Wait for the tap to show itself: a question sheet, the
                    # "request sent" page, or a changed button. One read 2.5 s
                    # later saw the unchanged page and recorded a real request as
                    # "the state did not change".
                    nodes = await self._wait_for(
                        lambda screen: read_form(screen, record.name) is not None
                        or form_done(screen)
                        or join_control(screen, record.name)[1] not in ("joinable", ""))
                    return await self._settle_join(record, nodes)
                elif state in JOINED_LABELS:
                    record.state = "requested" if "request" in state else "joined"
                    record.note = f"already {state}"
                else:
                    record.state = "requested" if pending else "refused"
                    record.note = "no Join control on the group page"
                return record
            except PhoneUnavailable as err:
                record.state = "requested" if pending else ("failed" if tapped else "candidate")
                record.note = str(err)
                if tapped:
                    self.store.review({"kind": "join-unverified", "group": record.name,
                                       "why": str(err)})
                return record
            finally:
                self.store.put(record)
                self.phone._release_phone()

    async def _open_group(self, name: str) -> bool:
        """Open a group by tapping its card, for the results that carry no URL.

        Facebook's search results put a card's text in the accessibility tree but
        not its link, so the card itself is the only handle. False means the card
        was not found, which is reported rather than guessed at.
        """
        loaded = await self._submit_search(name)
        for attempt in range(3):
            nodes = await self._screen()
            if group_page_open(nodes, name):
                # The exact name went straight to the group's page, which is what
                # this method is for.
                return True
            card = group_card(nodes, name)
            if card is not None:
                await self.phone._tap(card)
                # Wait for the page itself: reading once right after the tap saw
                # only the app's chrome and was reported as "opened no Join
                # control" for a group that was loading normally.
                nodes = await self._wait_for(
                    lambda screen: group_page_open(screen, name)
                    or join_control(screen, name)[0] is not None)
                if group_page_open(nodes, name) or join_control(nodes, name)[0] is not None:
                    return True
                log.info("Facebook group %r: the card opened no Join control (%s)",
                         name, [n.label[:30] for n in visible(nodes)[:4]])
                return False
            if attempt == 0:
                # Name what was actually on the results screen. "Could not be
                # opened" alone sent the next reader to the wrong end of the
                # pipeline instead of to the search that found other groups.
                seen = [row.name for row in group_rows(nodes)[:3]]
                log.info("Facebook group %r is not on the results screen (saw %s)",
                         name, seen or "no group cards")
            if not loaded:
                # The search never verified and there is no card: pressing on
                # costs the phone a minute for nothing.
                log.info("Facebook group %r: the search did not verify, so it was not opened", name)
                return False
            await self.phone._swipe(_feed_swipe(*await self.phone._geometry()))
            await self._settle(2.0)
        return False

    # ── the feed ─────────────────────────────────────────────────────────────

    async def visit(self, group: GroupRecord, per_group: int = 6) -> GroupVisit:
        """One pass over a group's feed: like, comment, reply, follow.

        Every action goes through `fb_engage.plan_post`, the caps, and the
        prompt gate. A post that fails any of them is skipped and counted, never
        posted as-is.
        """
        from .fb_engage import EngagementState, GroupSession, plan_post, read_post

        visit = GroupVisit(group=group.name)
        if group.state != "joined":
            visit.blocked = "membership has not been confirmed"
            return visit
        state = _engagement_state(self.store)
        session = self._session or GroupSession(self.limits)
        self._session = session
        async with self.phone._lock:
            if not await self.phone._hold_phone(wait_s=10):
                visit.blocked = "busy (another process is using the phone)"
                return visit
            try:
                visit.blocked = await self._turn()
                if visit.blocked:
                    return visit
                if group.url:
                    await self._open(group.url)
                elif not await self._open_group(group.name):
                    visit.blocked = "the group could not be opened from its card"
                    return visit
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
                    visit.posts_seen += 1
                    group.last_visit = time.time()
                    post = read_post(text, author=author, group=group.name,
                                     url=post_key(group, author, text))
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
                    if decision.comment:
                        _save_engagement_state(self.store, state)
                        commented = await self._comment(group, post, decision.cta)
                        state = _engagement_state(self.store)
                        if commented:
                            visit.comments += 1
                            state.commented_posts.add(post.url)
                            state.author_last_comment[author] = time.time()
                            state.touch(author, text)
                    if "reply" in decision.actions:
                        _save_engagement_state(self.store, state)
                        replied = await self._reply_thread(group, post, decision.reply_to[:2])
                        state = _engagement_state(self.store)
                        visit.replies += replied
                        if replied:
                            state.touch(author, text)
                    if "follow" in decision.actions:
                        if await self._follow(author):
                            visit.follows += 1
                            state.followed_authors.add(author)
                        break  # A follow attempt navigates away from the group feed.
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
            generation = await asyncio.to_thread(self._prompts, request)
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
        if reply.cta_used and reply.dm_followup:
            self.store.cache.set("fb-dm-drafts", f"{group.name}\0{post.author}",
                                 {"post": post.url, "text": reply.dm_followup}, self.store.TTL)
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
        if looks_published(after, safe):
            log.info("Comment posted and verified (%d words)", len(safe.split()))
            return True
        log.info("The comment did not appear to post")
        self.store.review({"kind": "comment-unverified", "post": key,
                           "text": safe, "why": "Submit was tapped but publication was not verified"})
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
        if group.state != "joined" or max_dms <= 0:
            return sent
        state = _engagement_state(self.store)
        candidates = sorted(state.author_touches.items(), key=lambda kv: -kv[1])
        for author, _ in candidates:
            if len(sent) >= max_dms:
                break
            ok, why = dm_eligible(author, state, self.limits)
            if not ok:
                log.debug("No DM for %s: %s", author, why)
                continue
            allowed, why = await self._peek("dm")
            if not allowed:
                break
            line = await self._dm_text(group, author)
            if not line:
                continue
            async with self.phone._lock:
                if not await self.phone._hold_phone(wait_s=10):
                    break
                try:
                    if await self._turn():
                        break
                    if await self._send_dm(author, line):
                        state.dm_sent.add(author)
                        sent.append((author, line))
                        _save_engagement_state(self.store, state)
                except PhoneUnavailable as err:
                    self.store.review({"kind": "dm-unverified", "author": author,
                                       "group": group.name, "why": str(err)})
                    break
                finally:
                    self.phone._release_phone()
        return sent

    async def _dm_text(self, group: GroupRecord, author: str) -> str:
        """The opener: their own words, then the thing they asked for.

        A DM that could have been sent to anybody is a blast, and a blast from a
        new account is how a group membership ends.
        """
        state = _engagement_state(self.store)
        draft = self.store.cache.get("fb-dm-drafts", f"{group.name}\0{author}") or {}
        # Only send a complete payoff offered in a successfully published comment.
        # The old opener claimed to include a resource but included no resource.
        text = str(draft.get("text") or "").strip()
        if draft.get("post") not in state.commented_posts or len(text) > 1200:
            return ""
        return text

    async def _send_dm(self, author: str, text: str) -> bool:
        """Open Messenger, find the thread, send, verify."""
        if self.store.cache.get("fb-dm-attempt", author):
            return False  # an unverified send must not be repeated after restart
        await self._open(MESSAGES_URL, MESSENGER)
        await self._settle(PAGE_SETTLE_S)
        nodes = await self._screen()
        threads = [n for n in nodes if n.package.startswith(MESSENGER) and n.clickable
                   and author.casefold() == n.label.casefold().strip()]
        if len(threads) != 1:
            return False
        await self.phone._tap(threads[0])
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
        allowed, why = await self._reserve("dm")
        if not allowed:
            return False
        self.store.cache.set("fb-dm-attempt", author, {"at": time.time()}, self.store.TTL)
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
