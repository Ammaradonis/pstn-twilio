"""Replay navigation failures and state transitions without a phone or network."""

import asyncio
import sys
from pathlib import Path
from unittest.mock import AsyncMock, Mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from email_finder.android import Node, PhoneUnavailable
from email_finder.cache import Cache
from email_finder.fb_engage import FbLimits
from email_finder.fb_groups import (
    FacebookGroups, GroupRecord, GroupStore, group_card, join_control,
    looks_published, post_key,
)
from email_finder.fb_vocab import GroupCandidate


FB = "com.facebook.katana"
NAME = "Nottingham Business Promotions"


def node(label, *, top=300, selected=False, rid="", clickable=True):
    return Node(label, "", rid, FB, clickable, (200, top + 20),
                (10, top, 600, top + 40), selected)


def driver(tmp_path):
    phone = Mock()
    phone.cache = Cache(tmp_path / "cache.sqlite")
    phone._lock = asyncio.Lock()
    phone._hold_phone = AsyncMock(return_value=True)
    phone._tap = AsyncMock()
    phone._key = AsyncMock()
    phone._wait = AsyncMock()
    phone._screen = AsyncMock(return_value=[])
    store = GroupStore(phone.cache)
    groups = FacebookGroups(phone, store, limits=FbLimits(quiet_hours=None))
    groups._turn = AsyncMock(return_value="")
    groups._guard = AsyncMock(return_value="")
    groups._open = AsyncMock()
    groups._open_group = AsyncMock(return_value=True)
    return groups, phone, store


def candidate():
    return GroupCandidate(name=NAME, members=5800, score=87, kind="owners")


def test_live_named_join_button_is_scoped_to_the_expected_group():
    button = node(f"Join {NAME} group")
    assert join_control([button], NAME) == (button, "joinable")
    assert join_control([button], "Another Group") == (None, "")


def test_search_field_and_partial_name_are_not_group_cards():
    field = node(NAME, top=58)
    result = node(f"{NAME},Public · 5.8K members")
    assert group_card([field, result], NAME) is result
    assert group_card([field], NAME) is None
    assert group_card([result], "Nottingham Business") is None


def test_home_screen_is_not_a_completed_search(tmp_path):
    groups, phone, _ = driver(tmp_path)
    phone._screen.return_value = [node("What's on your mind?")]
    assert not asyncio.run(groups._submit_search(NAME))
    phone._key.assert_not_awaited()


def test_all_results_with_group_cards_still_selects_groups_filter(tmp_path):
    groups, phone, _ = driver(tmp_path)
    field = node(NAME, top=58)
    clear = node("Clear text", top=58)
    chip = node("Groups search results", top=150)
    selected = node("Groups search results", top=150, selected=True)
    result = node(f"{NAME},Public · 5.8K members")
    phone._screen.side_effect = [[field, clear, chip, result], [selected, result]]
    assert asyncio.run(groups._submit_search(NAME))
    phone._tap.assert_awaited_once_with(chip)


def test_join_navigation_failure_does_not_spend_join_allowance(tmp_path):
    groups, phone, store = driver(tmp_path)
    groups._open_group.return_value = False
    record = asyncio.run(groups.join(candidate()))
    assert record.state == "failed"
    assert phone.cache.count("join") == 0
    assert record.join_attempts == 1
    assert store.join_queue(now=record.retry_at - 1) == []
    assert store.join_queue(now=record.retry_at + 1) == [record]


def test_verified_join_spends_once_and_is_not_repeated(tmp_path):
    groups, phone, store = driver(tmp_path)
    button = node(f"Join {NAME} group")
    phone._screen.side_effect = [[button], [node("Joined")]]
    record = asyncio.run(groups.join(candidate()))
    assert record.state == "joined"
    assert phone.cache.count("join") == 1
    assert store.joined() == [record]
    asyncio.run(groups.join(candidate()))
    phone._tap.assert_awaited_once_with(button)


def test_uncertain_join_is_reviewed_and_not_automatically_retried(tmp_path):
    groups, phone, store = driver(tmp_path)
    phone._screen.return_value = [node(f"Join {NAME} group")]
    phone._tap.side_effect = PhoneUnavailable("input timed out")
    record = asyncio.run(groups.join(candidate()))
    assert record.state == "failed"
    assert not store.join_queue(now=record.retry_at + 1)
    assert store.review_queue()[0]["kind"] == "join-unverified"


def test_requested_membership_is_not_ready_for_engagement(tmp_path):
    groups, phone, store = driver(tmp_path)
    record = GroupRecord(NAME, state="requested")
    store.put(record)
    assert store.needs_visit() == []
    assert asyncio.run(groups.visit(record)).blocked
    phone._hold_phone.assert_not_awaited()


def test_pending_request_is_rechecked_without_another_join_tap(tmp_path):
    groups, phone, store = driver(tmp_path)
    store.put(GroupRecord(NAME, state="requested", members=5800, score=87))
    assert store.join_queue()
    phone._screen.return_value = [node("Joined")]
    record = asyncio.run(groups.join(candidate()))
    assert record.state == "joined"
    assert phone.cache.count("join") == 0
    phone._tap.assert_not_awaited()


def test_pending_request_never_reclicks_join_when_membership_is_unclear(tmp_path):
    groups, phone, store = driver(tmp_path)
    store.put(GroupRecord(NAME, state="requested", members=5800, score=87))
    phone._screen.return_value = [node(f"Join {NAME} group")]
    record = asyncio.run(groups.join(candidate()))
    assert record.state == "requested"
    phone._tap.assert_not_awaited()


def test_join_retry_budget_and_unverified_suggestions_are_excluded(tmp_path):
    _, _, store = driver(tmp_path)
    store.put(GroupRecord("query suggestion", score=90))
    store.put(GroupRecord(NAME, score=87, members=5800, join_attempts=3))
    assert store.join_queue() == []


def test_cooldown_survives_a_new_driver(tmp_path):
    groups, phone, store = driver(tmp_path)
    assert asyncio.run(groups._reserve("join"))[0]
    again = FacebookGroups(phone, store, limits=FbLimits(quiet_hours=None))
    ok, why = asyncio.run(again._peek("join"))
    assert not ok and why == "join cooldown"
    assert phone.cache.count("join") == 1


def test_post_identity_is_stable_and_scoped():
    assert post_key(GroupRecord("A"), "Coach", "Question here") == post_key(
        GroupRecord("A"), "Coach", "Question  here")
    assert post_key(GroupRecord("A"), "Coach", "Question") != post_key(
        GroupRecord("B"), "Coach", "Question")


def test_composer_contents_do_not_count_as_a_published_comment():
    text = "Check whether enquiries are answered before changing the adverts."
    assert not looks_published([node(text, rid="comment_edit_text")], text)


def test_visit_preserves_cta_and_comment_history(tmp_path, monkeypatch):
    groups, phone, store = driver(tmp_path)
    groups.limits.follow = groups.limits.reply = False
    groups._like = AsyncMock(return_value=True)
    groups._draft = AsyncMock(return_value="Useful answer. DM me for the checklist.")
    groups._type_and_submit = AsyncMock(return_value=True)
    groups._next_post = AsyncMock()
    post = "How do you handle enquiries at our school when nobody is available to answer the phone?"
    monkeypatch.setattr("email_finder.fb_groups.post_rows", lambda nodes: [("Coach", post)])
    record = GroupRecord(NAME, state="joined")
    visit = asyncio.run(groups.visit(record, per_group=1))
    key = post_key(record, "Coach", post)
    restored = GroupStore(phone.cache).state()
    assert visit.comments == 1 and visit.posts_seen == 1
    assert key in restored["cta_used_posts"]
    assert key in restored["commented_posts"]
    assert key in restored["liked_posts"]
    assert len(restored["comment_texts"][key]) == 1


def test_outreach_uses_actual_payoff_only_after_publication(tmp_path):
    groups, _, store = driver(tmp_path)
    group = GroupRecord(NAME, state="joined")
    store.cache.set("fb-dm-drafts", f"{NAME}\0Coach",
                    {"post": "p", "text": "First count unanswered enquiries. Then count bookings."}, 100)
    assert asyncio.run(groups._dm_text(group, "Coach")) == ""
    store.engage = {"commented_posts": ["p"]}
    store.save_state()
    assert asyncio.run(groups._dm_text(group, "Coach")).startswith("First count")


def test_quiet_hours_do_not_wake_or_read_phone(tmp_path, monkeypatch):
    groups, phone, _ = driver(tmp_path)
    monkeypatch.setattr("email_finder.ambient.in_quiet_hours", lambda *args: True)
    assert asyncio.run(FacebookGroups._turn(groups)) == "quiet hours"
    phone.available.assert_not_called()
    phone._screen.assert_not_awaited()
