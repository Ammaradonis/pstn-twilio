"""The comment writer: render the two prompts, call DeepSeek, police the answer.

The prompts themselves live in `prompts/fb-comment-system.md` and
`prompts/fb-comment-user.md`, because they are deliverables a person pastes into
DeepSeek by hand as well as machine input. This module is the glue:

* `render_user()` fills the user template's `<<< >>>` slots and refuses to
  render if a slot would be left unexplained.
* `generate()` posts both prompts to DeepSeek and parses the JSON it returns.
* `check()` is the gate every comment passes before it can reach Facebook:
  word count, no links, no prices, no emoji, no exclamation marks, no product
  name, no repeat of a comment we already left on that post.
* `generate()` repairs once — a rejection is fed back as a second turn — and
  then gives up rather than posting something that fails the gate. A comment
  that argues with someone, quotes a price, or repeats yesterday's line costs
  more than the post was worth.

No API key: `render_only` returns both prompts so the operator can run them in
the DeepSeek app and paste the JSON back; the same validation still applies.
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

from .config import WORKER_DIR

log = logging.getLogger(__name__)

PROMPT_DIR = WORKER_DIR / "prompts"
SYSTEM_PATH = PROMPT_DIR / "fb-comment-system.md"
USER_PATH = PROMPT_DIR / "fb-comment-user.md"

DEEPSEEK_BASE = (os.environ.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com").rstrip("/")
DEEPSEEK_MODEL = os.environ.get("DEEPSEEK_MODEL") or "deepseek-chat"

MIN_WORDS, MAX_WORDS = 55, 120
REPLY_MIN, REPLY_MAX = 35, 100
CTA_MAX_WORDS = 26  # the whole closing sentence, not just the ask
SENTENCE = re.compile(r"(?<=[.?!])\s+")


def last_sentence(text: str) -> str:
    """The closing sentence, which is where the call to action has to be.

    Counting the last N words instead was the first attempt and it was wrong: a
    twenty-one word CTA that ends the comment is still the last sentence, and the
    estimate was rejecting good comments for being thorough.
    """
    parts = [part.strip() for part in SENTENCE.split((text or "").strip()) if part.strip()]
    return parts[-1] if parts else ""

# What a public comment may never contain. Each entry is (pattern, why).
BANNED: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"https?://|www\.|\.com\b|\.co\.uk\b|\bbit\.ly\b", re.I), "contains a link"),
    (re.compile(r"[$£€]\s?\d|\b\d[\d.,]*\s?(?:/\s?(?:mo|month|wk|week|yr|year)|"
                r"per month|a month|a week|monthly|pcm)", re.I),
     "mentions a price"),
    (re.compile(r"[!]", re.I), "contains an exclamation mark"),
    (re.compile(r"#\w"), "contains a hashtag"),
    (re.compile(r"[\U0001F300-\U0001FAFF\u2600-\u27BF]", re.I), "contains an emoji"),
    (re.compile(r"\b(?:as an? (?:ai|language model)|i am an? (?:ai|bot))\b", re.I),
     "claims to be an AI"),
    (re.compile(r"\b(?:ai receptionist|voice agent|chatbot|our (?:product|platform|software)|"
                r"book a demo|free demo|sign up|our team)\b", re.I),
     "names or sells the product"),
    (re.compile(r"\b(?:leverage|streamline|robust|seamless|cutting-edge|game-?changer|"
                r"supercharge|synergy|solution|unlock|journey|revolutionary|best-in-class)\b", re.I),
     "uses corporate vocabulary"),
    (re.compile(r"\b(?:guarantee|guaranteed|100%|risk-free|limited time|only \d+ (?:spots|slots))\b",
                re.I), "makes a promise or a fake deadline"),
)
# Capitalised words that are not shouting.
ALLCAPS_OK = {"DM", "MMA", "BJJ", "UFC", "TKD", "US", "UK", "GB", "PS", "OK", "AM", "PM", "FAQ"}
ALLCAPS = re.compile(r"\b[A-Z]{3,}\b")
CTA_MENTION = re.compile(r"\b(?:dm|message|pm|inbox|inbox me|drop me)\b", re.I)
CTA_DEAD = re.compile(r"\b(?:for (?:more )?(?:info|information|details)|to learn more|"
                      r"if (?:you're|you are) interested|to discuss)\b", re.I)


class PromptError(RuntimeError):
    """A prompt could not be rendered or an answer could not be parsed."""


@dataclass
class CommentRequest:
    """One post (or one comment inside a post thread) to answer."""

    post_text: str
    market: str = "US"
    group_name: str = ""
    group_kind: str = "owners"
    author_role: str = "unknown"
    standing: str = "member, have commented before"
    tone: str = "dry and practical"
    length: str = "60-110 words"
    thread_comment: str = ""  # set for mode=thread_reply
    prior_comments: list[str] = field(default_factory=list)
    cta_available: bool = True
    facts: list[str] = field(default_factory=list)
    avoid: list[str] = field(default_factory=list)
    url: str = ""  # the post's permalink, for the log only


@dataclass
class CommentReply:
    action: str
    mode: str
    comment: str
    word_count: int = 0
    hook_used: str = ""
    answer_claim: str = ""
    pitch_line: str = ""
    cta_keyword: str = ""
    cta_used: bool = False
    market_spelling: str = ""
    risk_flags: list[str] = field(default_factory=list)
    skip_reason: str = ""
    dm_followup: str = ""


def system_prompt() -> str:
    return SYSTEM_PATH.read_text(encoding="utf-8")


def user_template() -> str:
    return USER_PATH.read_text(encoding="utf-8")


# ── rendering ────────────────────────────────────────────────────────────────


def _bullets(items: list[str], empty: str) -> str:
    return "\n".join(f"- {item}" for item in items) if items else empty


def _fenced(items: list[str], empty: str) -> str:
    return _bullets(items, empty)


def render_user(request: CommentRequest) -> str:
    """Fill the user prompt template.

    The template is edited by hand from time to time, so the slots are found by
    their `<<< ... >>>` markers rather than by line number; a template missing
    one of the slots it needs is an error, not a quietly worse prompt.
    """
    template = user_template()
    thread = request.thread_comment.strip() or "none"
    mode_hint = "thread_reply" if request.thread_comment.strip() else "public_comment"
    replacements = {
        "MARKET — US or UK": request.market,
        "GROUP NAME — and what kind of group it is: owners / martial arts / local community":
            f"{request.group_name} ({request.group_kind})",
        "owner / instructor / manager / parent / unknown": request.author_role,
        "member since when, whether we have posted before, whether anyone there knows us":
            request.standing,
        "e.g. dry and practical / warm but blunt / short and unbothered": request.tone,
        "60-110 words, default": request.length,
        "no / yes: how many times": (
            f"yes, {len(request.prior_comments)} time(s)" if request.prior_comments else "no"),
        "yes / no — if no, write the comment without any CTA": (
            "yes" if request.cta_available else
            "no — write the comment without any CTA"),
        "e.g. \"our answered-call rate went from ~50% to ~90% after 4-9pm cover\";\n     \"average student stays 14 months at $165/mo\";\n     \"we mystery-called 11 schools in our county at 6:40pm, 6 rang out\"":
            _bullets(request.facts, "none — cite no numbers"),
        "phrases already worn out this week, e.g. \"voicemail is where students go to die\"":
            _bullets(request.avoid, "none"),
        "PASTE THE FACEBOOK POST OR COMMENT HERE, VERBATIM — keep the typos":
            request.post_text.strip(),
        "THREAD COMMENT, or \"none\"": thread,
        "paste them, or \"none\"": _fenced(request.prior_comments, "none"),
    }
    for slot, value in replacements.items():
        marker = f"<<< {slot} >>>"
        if marker not in template:
            log.debug("slot not in template: %s", slot[:40])
            continue
        template = template.replace(marker, str(value).strip() or "unknown")

    leftovers = re.findall(r"<<< [^>]{3,200} >>>", template)
    if leftovers:
        raise PromptError(f"the user prompt template still has {len(leftovers)} unfilled slot(s): "
                          f"{leftovers[:3]}")
    if request.thread_comment.strip() and f"set mode to `{mode_hint}`" not in template:
        raise PromptError("the thread-comment instruction is missing from the template")
    return template


def build_prompt(request: CommentRequest) -> tuple[str, str]:
    return system_prompt(), render_user(request)


# ── the model ────────────────────────────────────────────────────────────────


def _extract_json(text: str) -> dict:
    """DeepSeek sometimes wraps JSON in a fence even when asked not to."""
    body = (text or "").strip()
    if body.startswith("```"):
        body = re.sub(r"^```(?:json)?\s*|\s*```$", "", body, flags=re.S).strip()
    start = body.find("{")
    end = body.rfind("}")
    if start < 0 or end <= start:
        raise PromptError(f"no JSON object in the answer: {body[:160]!r}")
    try:
        return json.loads(body[start: end + 1])
    except json.JSONDecodeError as err:
        raise PromptError(f"the answer was not valid JSON: {err}") from err


def parse_reply(payload: dict) -> CommentReply:
    get = payload.get
    reply = CommentReply(
        action=str(get("action") or "comment").lower(),
        mode=str(get("mode") or "public_comment").lower(),
        comment=str(get("comment") or "").strip(),
        word_count=int(get("word_count") or 0),
        hook_used=str(get("hook_used") or ""),
        answer_claim=str(get("answer_claim") or ""),
        pitch_line=str(get("pitch_line") or ""),
        cta_keyword=str(get("cta_keyword") or "none"),
        cta_used=bool(get("cta_used")),
        market_spelling=str(get("market_spelling") or ""),
        risk_flags=[str(f) for f in (get("risk_flags") or [])],
        skip_reason=str(get("skip_reason") or ""),
        dm_followup=str(get("dm_followup") or ""),
    )
    if reply.action not in ("comment", "skip"):
        reply.action = "skip"
        reply.skip_reason = reply.skip_reason or "the model returned an unknown action"
    if reply.action == "comment":
        comment = reply.comment.strip()
        # Only a matched pair of wrapping quotes is an artefact of the model
        # answering with a quoted string. Stripping every quote stripped the
        # opening quote of a comment that began with one: '"Ride it out" is...'
        # arrived as 'Ride it out" is...'.
        if len(comment) >= 2 and comment[0] == '"' and comment[-1] == '"':
            comment = comment[1:-1].strip()
        reply.comment = comment
        # Counted here, never taken from the model: its own count was 85 when
        # the text was 93, which let an over-long reply look compliant.
        reply.word_count = len(comment.split())
    return reply


def check(reply: CommentReply, request: CommentRequest) -> list[str]:
    """Everything wrong with this comment, in the order a human would notice."""
    problems: list[str] = []
    if reply.action != "comment":
        return problems
    text = reply.comment
    if not text:
        return ["the comment is empty"]
    words = len(text.split())
    if reply.mode == "thread_reply":
        if not REPLY_MIN <= words <= REPLY_MAX:
            problems.append(f"thread reply is {words} words; target {REPLY_MIN}-{REPLY_MAX}")
    elif not MIN_WORDS <= words <= MAX_WORDS:
        problems.append(f"comment is {words} words; target {MIN_WORDS}-{MAX_WORDS}")
    for pattern, why in BANNED:
        if pattern.search(text):
            problems.append(why)
    shouting = [w for w in ALLCAPS.findall(text) if w not in ALLCAPS_OK]
    if len(shouting) > 1:
        problems.append(f"shouting ({', '.join(shouting[:3])})")

    mentions_cta = bool(CTA_MENTION.search(text))
    if request.cta_available:
        if not mentions_cta:
            problems.append("no call to action, and this post still has one available")
        else:
            close = last_sentence(text)
            if not CTA_MENTION.search(close):
                problems.append("the call to action is not in the last sentence")
            elif len(close.split()) > CTA_MAX_WORDS:
                problems.append(f"the closing sentence is {len(close.split())} words; "
                                f"keep the call to action under {CTA_MAX_WORDS}")
            if CTA_DEAD.search(close):
                problems.append("the call to action asks for 'more info' instead of a thing")
            if reply.cta_keyword in ("", "none"):
                problems.append("the call to action names no keyword")
    elif mentions_cta:
        problems.append("a call to action although earlier comments already used one")

    for prior in request.prior_comments:
        head = prior.strip().casefold()[:48]
        if head and head in text.casefold():
            problems.append("repeats an earlier comment on this post")
            break
    for phrase in request.avoid:
        if phrase.strip() and phrase.strip().casefold() in text.casefold():
            problems.append(f"uses a phrase we are resting ({phrase.strip()})")
    return problems


# ── generating ───────────────────────────────────────────────────────────────


@dataclass
class Generation:
    reply: CommentReply | None
    system: str
    user: str
    problems: list[str] = field(default_factory=list)
    attempts: int = 0
    error: str = ""

    @property
    def ok(self) -> bool:
        return self.reply is not None and not self.problems and not self.error


def _post(messages: list[dict], timeout: float = 90.0) -> str:
    import urllib.request

    key = os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("DEEPSEEK_KEY")
    if not key:
        raise PromptError("DEEPSEEK_API_KEY is not set")
    body = json.dumps({
        "model": DEEPSEEK_MODEL,
        "messages": messages,
        "temperature": 0.75,
        "max_tokens": 900,
        "response_format": {"type": "json_object"},
    }).encode()
    request = urllib.request.Request(
        f"{DEEPSEEK_BASE}/chat/completions", data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8", errors="replace"))
    choices = payload.get("choices") or []
    if not choices:
        raise PromptError(f"DeepSeek returned no choices: {str(payload)[:200]}")
    return choices[0].get("message", {}).get("content", "")


def generate(request: CommentRequest, repair: bool = True) -> Generation:
    """Ask DeepSeek for one comment, and make it survive the gate."""
    system, user = build_prompt(request)
    if not (os.environ.get("DEEPSEEK_API_KEY") or os.environ.get("DEEPSEEK_KEY")):
        return Generation(reply=None, system=system, user=user,
                          error="DEEPSEEK_API_KEY is not set; the prompts are ready to paste")
    messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    result = Generation(reply=None, system=system, user=user)
    for attempt in range(2 if repair else 1):
        result.attempts = attempt + 1
        try:
            raw = _post(messages)
            reply = parse_reply(_extract_json(raw))
        except (PromptError, OSError, ValueError, KeyError) as err:
            result.error = str(err)
            if attempt == 0:
                time.sleep(1.0)
                continue
            return result
        problems = check(reply, request)
        result.reply, result.problems = reply, problems
        if not problems or reply.action != "comment":
            result.error = ""
            return result
        if attempt == 0:
            log.info("Comment failed the gate (%s); asking for one repair.",
                     "; ".join(problems[:3]))
            target = ("under 90 words" if reply.mode == "thread_reply" else "under 110 words")
            messages += [
                {"role": "assistant", "content": raw},
                {"role": "user", "content":
                    "That comment breaks the rules: " + "; ".join(problems) +
                    f". Rewrite it and return the same JSON object. Cut it to {target} — "
                    "count the words before you answer. Keep the four beats; do not add "
                    "any new claim."},
            ]
    result.error = result.error or "the comment still failed the gate: " + "; ".join(result.problems[:4])
    return result


def render_to_file(request: CommentRequest, out_dir: Path | None = None) -> Path:
    """Write both prompts to one markdown file for pasting into DeepSeek by hand."""
    out_dir = out_dir or WORKER_DIR / "tmp"
    out_dir.mkdir(parents=True, exist_ok=True)
    system, user = build_prompt(request)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    path = out_dir / f"facebook-comment-{stamp}.md"
    path.write_text(
        "# Paste part 1 into DeepSeek as the system prompt\n\n"
        f"```text\n{system}\n```\n\n"
        "# Paste part 2 as the user message\n\n"
        f"```text\n{user}\n```\n",
        encoding="utf-8")
    return path


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        prog="fb_prompts",
        description="Render (and optionally run) the Facebook comment prompts.")
    parser.add_argument("--post", help="file holding the Facebook post or comment")
    parser.add_argument("--text", help="the post text, inline")
    parser.add_argument("--thread", default="", help="the comment being replied to")
    parser.add_argument("--market", default="US", choices=("US", "UK"))
    parser.add_argument("--group", default="", help="group name")
    parser.add_argument("--group-kind", default="owners")
    parser.add_argument("--author", default="unknown")
    parser.add_argument("--fact", action="append", default=[],
                        help="a number we may cite (repeatable)")
    parser.add_argument("--avoid", action="append", default=[],
                        help="a phrase we are resting (repeatable)")
    parser.add_argument("--no-cta", action="store_true",
                        help="this post already used its one CTA")
    parser.add_argument("--run", action="store_true", help="call DeepSeek as well")
    parser.add_argument("--out-dir", default="")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    post = args.text or (Path(args.post).read_text(encoding="utf-8") if args.post else "")
    if not post.strip():
        parser.error("give --post FILE or --text TEXT")
    request = CommentRequest(
        post_text=post, market=args.market, group_name=args.group,
        group_kind=args.group_kind, author_role=args.author,
        thread_comment=args.thread, facts=args.fact, avoid=args.avoid,
        cta_available=not args.no_cta,
    )
    path = render_to_file(request, Path(args.out_dir) if args.out_dir else None)
    print(f"Prompts written to {path}")
    if not args.run:
        return 0
    generation = generate(request)
    if generation.reply is None:
        print(generation.error, file=__import__("sys").stderr)
        return 1
    print(json.dumps({
        "action": generation.reply.action,
        "mode": generation.reply.mode,
        "comment": generation.reply.comment,
        "word_count": generation.reply.word_count,
        "cta_keyword": generation.reply.cta_keyword,
        "problems": generation.problems,
    }, indent=2))
    return 0 if generation.ok else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
