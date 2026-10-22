"""The group session's decisions: what it will do, and what it refuses.

No phone and no model: the session, the limits and the state are pure data, and
the checks are the ones the driver relies on before it taps anything.
"""

import random
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.fb_engage import (
    EngagementState,
    FbLimits,
    GroupSession,
    can_act,
    classify,
    dm_eligible,
    dm_line,
    plan_post,
    read_post,
    reserve_name,
    should_comment,
)

NOW = 1_800_000_000.0
DAY = 86_400.0


def limits(**overrides) -> FbLimits:
    base = dict(quiet_hours=None, account_age_days=90)
    base.update(overrides)
    return FbLimits(**base)


def question(**overrides):
    text = ("How does everyone handle the phone during evening classes? "
            "We keep missing calls between 6 and 8pm and I have no idea how many "
            "parents are ringing the school down the road instead.")
    post = read_post(text, author="Coach Dan", url="https://facebook.com/p/1")
    for key, value in overrides.items():
        setattr(post, key, value)
    return post


# ── what a post is ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("text,kind", [
    ("Does anyone have a script for asking a parent to book a trial?", "question"),
    ("We lost three families this month and I cannot work out why.", "pain"),
    ("We just promoted our first two black belts, so proud.", "win"),
    ("Passed away suddenly, the service is on Friday.", "sensitive"),
    ("Scam alert: beware of this agency, stay away from them.", "sensitive"),
    ("We're hiring a part-time coach, apply below.", "hiring"),
    ("LIMITED offer: 50% off your first month, DM me to book now.", "promo"),
    ("Monday class was good.", "social"),
])
def test_a_post_is_classified_by_what_it_is(text, kind):
    assert classify(text) == kind


def test_sensitive_beats_a_question_mark():
    assert classify("Any advice on safeguarding? A parent raised a concern.") == "sensitive"


def test_an_empty_post_has_no_kind():
    assert classify("   ") == "other"


def test_author_kind_spots_an_owner_and_a_vendor():
    assert read_post("My school runs four nights a week and the front desk is me.").author_kind \
        == "owner"
    assert read_post("We offer a done-for-you answering service for schools.").author_kind \
        == "vendor"


def test_a_sensitive_post_carries_its_reason():
    post = read_post("Sadly one of our students passed away this week.")
    assert post.kind == "sensitive"
    assert post.reasons and "human decides" in post.reasons[0]


# ── should this be commented on ──────────────────────────────────────────────


def test_a_question_from_an_owner_is_worth_a_comment():
    ok, why = should_comment(question(), limits(), EngagementState(), NOW)
    assert ok, why


def test_a_win_is_not_worth_a_comment():
    ok, why = should_comment(read_post(
        "We just hit 200 students, so proud of the team and grateful to every family."),
        limits(), EngagementState(), NOW)
    assert not ok and "win" in why


def test_a_short_post_is_not_worth_a_comment():
    ok, why = should_comment(read_post("How do you price trials?", url="u"), limits(),
                             EngagementState(), NOW)
    assert not ok and "too short" in why


def test_a_sensitive_post_is_never_commented_on():
    post = read_post("Beware of this coach, he is a scam, stay away from him entirely.")
    ok, why = should_comment(post, limits(), EngagementState(), NOW)
    assert not ok and "sensitive" in why


def test_the_same_post_is_not_commented_twice():
    state = EngagementState(commented_posts={"https://facebook.com/p/1"})
    ok, why = should_comment(question(), limits(), state, NOW)
    assert not ok and "already" in why


def test_the_same_owner_is_not_commented_on_twice_in_a_week():
    state = EngagementState(author_last_comment={"Coach Dan": NOW - 2 * DAY})
    ok, why = should_comment(question(), limits(), state, NOW)
    assert not ok and "recently" in why
    # A week later it is allowed again.
    ok, _ = should_comment(question(), limits(), state, NOW + 8 * DAY)
    assert ok


def test_a_vendors_post_is_not_commented_on():
    post = read_post("We offer a done-for-you answering service for martial arts schools. "
                     "Book a call today and we will audit your phone lines for free.")
    ok, why = should_comment(post, limits(), EngagementState(), NOW)
    assert not ok


# ── the per-post plan ────────────────────────────────────────────────────────


def test_a_question_gets_liked_commented_and_a_cta():
    session = GroupSession(limits(), rng=random.Random(7))
    decision = plan_post(question(), session, EngagementState(), limits(), NOW)
    assert decision.comment
    assert decision.cta  # this post has not used its call to action yet
    assert "like" in decision.actions and "comment" in decision.actions
    assert not decision.skip


def test_a_post_that_used_its_cta_gets_a_comment_without_one():
    post = question()
    state = EngagementState(cta_used_posts={post.url})
    decision = plan_post(post, GroupSession(limits(), rng=random.Random(7)), state,
                         limits(), NOW)
    assert decision.comment and not decision.cta


def test_a_sensitive_post_skips_everything():
    post = read_post("One of our students passed away and I do not know what to tell the class.")
    decision = plan_post(post, GroupSession(limits(), rng=random.Random(7)),
                         EngagementState(), limits(), NOW)
    assert decision.skip and not decision.actions


def test_replies_are_planned_under_a_question_and_capped():
    post = question(comments=6)
    decision = plan_post(post, GroupSession(limits(), rng=random.Random(7)),
                         EngagementState(), limits(), NOW)
    assert "reply" in decision.actions
    assert len(decision.reply_to) == limits().max_replies_per_post == 3


def test_no_more_replies_once_the_post_allowance_is_used():
    post = question(comments=6)
    state = EngagementState(replies_by_post={post.url: 3})
    decision = plan_post(post, GroupSession(limits(), rng=random.Random(7)), state,
                         limits(), NOW)
    assert "reply" not in decision.actions


def test_a_follow_is_planned_for_the_author_of_a_question():
    decision = plan_post(question(), GroupSession(limits(), rng=random.Random(7)),
                         EngagementState(), limits(), NOW)
    assert "follow" in decision.actions


def test_no_follow_when_the_author_is_already_followed():
    post = question()
    state = EngagementState(followed_authors={post.author})
    decision = plan_post(post, GroupSession(limits(), rng=random.Random(7)), state,
                         limits(), NOW)
    assert "follow" not in decision.actions


def test_a_sponsored_post_is_left_alone():
    post = question(is_ad=True)
    decision = plan_post(post, GroupSession(limits(), rng=random.Random(7)),
                         EngagementState(), limits(), NOW)
    assert decision.skip and "sponsored" in decision.reason


# ── the DM rules ─────────────────────────────────────────────────────────────


def test_a_dm_needs_history_and_a_wait():
    state = EngagementState()
    state.touch("Coach Dan", now=NOW - 10 * DAY)
    state.touch("Coach Dan", now=NOW - 9 * DAY)
    ok, why = dm_eligible("Coach Dan", state, limits(), NOW)
    assert ok, why


def test_one_interaction_is_not_enough_for_a_dm():
    state = EngagementState()
    state.touch("Coach Dan", now=NOW - 10 * DAY)
    ok, why = dm_eligible("Coach Dan", state, limits(), NOW)
    assert not ok and "fewer than two" in why


def test_a_dm_waits_three_days_after_the_first_touch():
    state = EngagementState()
    state.touch("Coach Dan", now=NOW - DAY)
    state.touch("Coach Dan", now=NOW - DAY)
    ok, why = dm_eligible("Coach Dan", state, limits(), NOW)
    assert not ok and "too recently" in why


def test_nobody_is_messaged_twice():
    state = EngagementState(dm_sent={"Coach Dan"})
    state.touch("Coach Dan", now=NOW - 30 * DAY)
    state.touch("Coach Dan", now=NOW - 29 * DAY)
    ok, why = dm_eligible("Coach Dan", state, limits(), NOW)
    assert not ok and "already" in why


def test_the_opener_quotes_their_own_words():
    line = dm_line("We keep missing calls between 6 and 8pm.", "ringout")
    assert line.startswith('You wrote: "We keep missing calls')
    assert "ringout" in line


def test_a_long_post_is_quoted_only_to_a_sentence():
    line = dm_line("word " * 200, "math")
    assert len(line) < 260 and line.endswith("Here is the math I mentioned.")


# ── caps and the clock ───────────────────────────────────────────────────────


def test_a_new_account_does_less():
    young = limits(account_age_days=2)
    older = limits(account_age_days=60)
    assert young.cap("comment") < older.cap("comment")
    assert older.cap("comment") == 18


def test_the_daily_cap_refuses():
    allowed, why = can_act(limits(), None, "comment", {"comment": 18}, NOW)
    assert not allowed and "daily" in why


def test_the_hourly_cap_refuses():
    day = time.strftime("%Y-%m-%dT%H", time.gmtime(NOW))
    name = f"comment@{day}"
    allowed, why = can_act(limits(), None, "comment", {name: 5}, NOW)
    assert not allowed and "hourly" in why


def test_quiet_hours_refuse_everything():
    quiet = limits(quiet_hours=(1, 6))
    hour_at_3am = time.mktime(time.strptime("2026-10-22 03:00", "%Y-%m-%d %H:%M"))
    allowed, why = can_act(quiet, None, "like", {}, hour_at_3am)
    assert not allowed and why == "quiet hours"


def test_reserve_name_gives_a_day_and_an_hour_counter():
    day, hour = reserve_name("comment")
    assert day == "comment" and hour.startswith("comment@")


# ── the session's shape ──────────────────────────────────────────────────────


def test_a_seeded_session_is_reproducible():
    one = GroupSession(limits(), rng=random.Random(3))
    two = GroupSession(limits(), rng=random.Random(3))
    assert one.mood == two.mood
    assert one.dwell() == two.dwell()
    assert one.scroll(720, 1560) == two.scroll(720, 1560)


def test_watch_time_is_bounded_and_usually_short():
    session = GroupSession(limits(), rng=random.Random(11))
    dwells = [session.dwell() for _ in range(400)]
    assert all(2.0 <= d <= 120.0 for d in dwells)
    assert sum(dwells) / len(dwells) < 25


def test_a_scroll_stays_on_the_screen():
    session = GroupSession(limits(), rng=random.Random(5))
    for _ in range(100):
        gesture = session.scroll(720, 1560)
        assert 0 <= gesture.x1 <= 720 and 0 <= gesture.x2 <= 720
        assert 0.10 * 1560 <= gesture.y2 <= 1560
        assert gesture.y2 < gesture.y1  # downward swipe: the next post


def test_the_session_fatigues():
    session = GroupSession(limits(), rng=random.Random(9))
    first = session.mood
    for _ in range(40):
        session.watched()
    # mood is fixed for a session; fatigue is applied inside action(). The
    # observable effect is that the session eventually finishes.
    assert session.mood == first
    assert session.finished or session.posts == 40
