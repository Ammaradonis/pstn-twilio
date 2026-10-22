"""The two prompts and the gate a generated comment must pass.

No network: `generate()` is only tested for its behaviour without an API key, and
everything else is the rendering and the checking, which is where the money is.
"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.fb_prompts import (
    CommentRequest,
    CommentReply,
    _extract_json,
    build_prompt,
    check,
    generate,
    parse_reply,
    render_to_file,
    render_user,
    system_prompt,
    user_template,
)

GOOD = ('Price on the phone is a trap you set for yourself. We stopped quoting it. '
        'Whoever answers says the first class is free, asks the kid age, books a time. '
        'Cost gets discussed on the mat after they have watched their kid smile. '
        'Our answered rate went from about half to nearly all of it once someone other '
        'than me picked up between four and nine. DM me "ringout" and I will send the '
        'test we use.')
POST = ("How do you all handle parents asking price over the phone while you are "
        "teaching the evening class?")


def request(**overrides) -> CommentRequest:
    base = dict(post_text=POST, market="US", group_name="Martial Arts School Owners",
                group_kind="owners", author_role="owner")
    base.update(overrides)
    return CommentRequest(**base)


def reply(text: str = GOOD, **overrides) -> CommentReply:
    base = dict(action="comment", mode="public_comment", comment=text,
                cta_keyword="ringout", cta_used=True)
    base.update(overrides)
    return CommentReply(**base)


# ── the prompt files ─────────────────────────────────────────────────────────


def test_the_system_prompt_states_the_four_beats_and_the_bans():
    body = system_prompt().casefold()
    for expected in ("hook", "answer", "earned aside", "curiosity cta", "never mention price",
                     "no links", "skip", "json"):
        assert expected in body, expected


def test_the_user_prompt_has_the_slots_the_renderer_fills():
    template = user_template()
    assert "<<< MARKET" in template and "<<< PASTE THE FACEBOOK POST" in template
    assert '"action"' in template


# ── rendering ────────────────────────────────────────────────────────────────


def test_every_slot_is_filled():
    rendered = render_user(request(facts=["our answered rate went from 50% to 90%"],
                                   avoid=["leverage"], prior_comments=["An earlier comment."]))
    assert "<<<" not in rendered and ">>>" not in rendered
    assert POST in rendered
    assert "Martial Arts School Owners (owners)" in rendered
    assert "our answered rate went from 50% to 90%" in rendered
    assert "An earlier comment." in rendered


def test_an_empty_context_says_none_rather_than_leaving_a_blank():
    rendered = render_user(request())
    assert "none — cite no numbers" in rendered
    assert "\nnone\n" in rendered


def test_a_thread_comment_is_carried_and_names_the_mode():
    rendered = render_user(request(thread_comment="Just answer the phone, it is not hard."))
    assert "Just answer the phone, it is not hard." in rendered
    assert 'set mode to `thread_reply`' in rendered


def test_the_no_cta_state_is_passed_through():
    rendered = render_user(request(cta_available=False))
    assert "no — write the comment without any CTA" in rendered


def test_earlier_comments_are_counted():
    rendered = render_user(request(prior_comments=["one", "two"]))
    assert "yes, 2 time(s)" in rendered


def test_build_prompt_returns_both_halves():
    system, user = build_prompt(request())
    assert system.startswith("# SYSTEM PROMPT")
    assert user.strip().startswith("# USER PROMPT")


def test_render_to_file_writes_both_parts(tmp_path):
    path = render_to_file(request(), out_dir=tmp_path)
    body = path.read_text(encoding="utf-8")
    assert "system prompt" in body.casefold() and "user message" in body.casefold()
    assert POST in body


# ── the gate ─────────────────────────────────────────────────────────────────


def test_a_good_comment_passes():
    assert check(reply(), request()) == []


def test_a_link_is_refused():
    text = GOOD.replace("We stopped quoting it.", "We stopped quoting it. Full details at example.com.")
    assert "contains a link" in check(reply(text), request())


def test_a_price_is_refused():
    text = GOOD.replace("DM me", "We charge 497/month. DM me")
    assert "mentions a price" in check(reply(text), request())


def test_an_exclamation_mark_is_refused():
    text = GOOD.replace("We stopped quoting it.", "We stopped quoting it!")
    assert "contains an exclamation mark" in check(reply(text), request())


def test_an_emoji_is_refused():
    text = GOOD.replace("We stopped quoting it.", "We stopped quoting it \U0001f525.")
    assert "contains an emoji" in check(reply(text), request())


def test_a_hashtag_is_refused():
    assert "contains a hashtag" in check(reply(GOOD + " #martialarts #dojolife ok."), request())


def test_claiming_to_be_an_ai_is_refused():
    text = GOOD.replace("We stopped quoting it.", "As an AI I cannot quote it.")
    assert "claims to be an AI" in check(reply(text), request())


def test_selling_the_product_by_name_is_refused():
    text = GOOD.replace("We stopped quoting it.", "Our AI receptionist stopped quoting it.")
    assert "names or sells the product" in check(reply(text), request())


def test_corporate_vocabulary_is_refused():
    assert "uses corporate vocabulary" in check(
        reply(GOOD.replace("We stopped quoting it.", "We leverage a seamless solution.")),
        request())


def test_a_guarantee_is_refused():
    assert "makes a promise or a fake deadline" in check(
        reply(GOOD.replace("We stopped quoting it.", "We guarantee 20 trials.")), request())


def test_a_missing_cta_is_refused_when_one_is_available():
    text = GOOD.split("DM me")[0].strip()
    problems = check(reply(text, cta_keyword="none"), request())
    assert any("no call to action" in problem for problem in problems)


def test_a_cta_that_is_not_last_is_refused():
    text = ('DM me "ringout" for the test. ' + GOOD.split("DM me")[0] +
            " The rest of this sentence is filler to push the call to action away from "
            "the end of the comment where it belongs.")
    problems = check(reply(text), request())
    assert any("not in the last sentence" in problem for problem in problems)


def test_a_thorough_closing_sentence_is_still_the_last_sentence():
    # The real model produced this one and the old word-window check rejected it.
    text = ('The price question only hurts because it lands while you are on the mat. '
            'Same here. We stopped quoting it on the phone. Whoever answers says the '
            'first class is free, asks the kid age, books a time. Cost gets talked about '
            'on the mat once they have watched their kid smile. I ring our own line at '
            '6:40pm every Tuesday, just to hear what a parent hears. DM me "price script" '
            'and I will send the three lines we use, plus what to say when they push.')
    assert check(reply(text), request()) == []


def test_a_rambling_closing_sentence_is_refused():
    text = GOOD.split("DM me")[0] + (
        'DM me "ringout" and I will send you the test, and while you are there let me '
        'tell you about the eleven other things I have learned about running a school '
        'over the last eleven years of doing this every single week without a break.')
    problems = check(reply(text), request())
    assert any("closing sentence" in problem for problem in problems)


def test_the_last_sentence_is_found_without_being_fooled_by_a_decimal():
    from email_finder.fb_prompts import last_sentence

    assert last_sentence("We got 12.4K views. Then we stopped.") == "Then we stopped."
    assert last_sentence("Single sentence here") == "Single sentence here"


def test_a_cta_asking_for_more_info_is_refused():
    text = GOOD.split("DM me")[0] + "DM me for more info about it all."
    problems = check(reply(text), request())
    assert any("more info" in problem for problem in problems)


def test_a_cta_is_refused_when_the_post_already_had_one():
    problems = check(reply(), request(cta_available=False))
    assert any("although earlier comments" in problem for problem in problems)


def test_a_cta_with_no_keyword_is_refused():
    problems = check(reply(cta_keyword="none"), request())
    assert any("names no keyword" in problem for problem in problems)


def test_repeating_an_earlier_comment_is_refused():
    head = GOOD[:60]
    problems = check(reply(), request(prior_comments=[head + " and more besides."]))
    assert any("repeats an earlier comment" in problem for problem in problems)


def test_using_a_resting_phrase_is_refused():
    problems = check(reply(), request(avoid=["Price on the phone is a trap"]))
    assert any("resting" in problem for problem in problems)


def test_a_comment_that_is_too_short_is_refused():
    short = 'Call your own line at 6:40 tonight. DM me "ringout" and I will send the test.'
    problems = check(reply(short), request())
    assert any("words; target" in problem for problem in problems)


def test_a_shouty_comment_is_refused():
    text = GOOD.replace("Price on the phone", "PRICE LOUDLY ALWAYS TOTALLY")
    assert any("shouting" in problem for problem in check(reply(text), request()))


def test_a_skip_reply_has_nothing_to_check():
    assert check(CommentReply(action="skip", mode="skip", comment=""), request()) == []


# ── parsing what the model said ──────────────────────────────────────────────


def test_fenced_json_is_unwrapped():
    body = '```json\n{"action": "comment", "comment": "hi"}\n```'
    assert _extract_json(body)["comment"] == "hi"


def test_surrounding_chatter_is_ignored():
    body = 'Here you go:\n{"action": "skip", "skip_reason": "a death post"}\nHope that helps.'
    assert _extract_json(body)["skip_reason"] == "a death post"


def test_a_body_with_no_json_is_an_error():
    from email_finder.fb_prompts import PromptError

    with pytest.raises(PromptError):
        _extract_json("no json here")


def test_a_reply_is_normalised():
    parsed = parse_reply({"action": "COMMENT", "mode": "public_comment",
                          "comment": '  "Text here."  ', "cta_keyword": "ringout"})
    assert parsed.action == "comment"
    assert parsed.comment == "Text here."
    assert parsed.word_count == 2


def test_an_unknown_action_becomes_a_skip():
    parsed = parse_reply({"action": "shrug", "comment": "hi"})
    assert parsed.action == "skip" and parsed.skip_reason


def test_a_comment_that_begins_with_a_quoted_phrase_keeps_its_quote():
    # Seen on a real run: '"Ride it out" is the one thing...' was being mangled
    # into 'Ride it out" is the one thing...' by stripping every quote.
    parsed = parse_reply({"action": "comment",
                          "comment": '"Ride it out" is the one thing that changes nothing.'})
    assert parsed.comment.startswith('"Ride it out"')


def test_a_wrapping_pair_of_quotes_is_still_removed():
    parsed = parse_reply({"action": "comment",
                          "comment": '"The whole comment wrapped in quotes."'})
    assert parsed.comment == "The whole comment wrapped in quotes."


def test_the_word_count_is_counted_here_not_trusted_from_the_model():
    # Seen on a real run: the model said 85 words, the text was 93, and the gate
    # let an over-long reply look compliant.
    parsed = parse_reply({"action": "comment", "comment": "one two three four five",
                          "word_count": 85})
    assert parsed.word_count == 5


def test_a_thread_reply_has_room_for_ninety_words():
    body = ("Ride it out is the one thing that guarantees it stays quiet. " * 4 +
            'DM me "ringout" and I will send the test.')
    problems = check(reply(body, mode="thread_reply"), request(thread_comment="ride it out"))
    assert not any("words; target" in problem for problem in problems), problems


# ── no key, no call ──────────────────────────────────────────────────────────


def test_without_a_key_the_prompts_are_returned_not_called(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("DEEPSEEK_KEY", raising=False)
    generation = generate(request())
    assert generation.reply is None
    assert "DEEPSEEK_API_KEY is not set" in generation.error
    assert POST in generation.user and generation.system
    assert not generation.ok
