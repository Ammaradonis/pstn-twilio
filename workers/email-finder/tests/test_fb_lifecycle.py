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
    FacebookGroups, GroupRecord, GroupStore, group_card, join_answer_text, join_control,
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
    phone._geometry = AsyncMock(return_value=(720, 1280))
    phone._swipe = AsyncMock()
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
    # A card the search could not find is not an attempt: charging it retired
    # groups after three unlucky searches that never tapped Join.
    assert record.join_attempts == 0
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


def test_a_search_that_lands_on_the_group_page_is_not_a_failure(tmp_path):
    # Facebook answers an exact group name by opening the group itself, and the
    # "Groups search results" chip never appears; the old code read that as a
    # failed search and gave up with the page it wanted already open.
    groups, phone, store = join_driver(tmp_path)
    groups._submit_search = AsyncMock(return_value=False)
    button = node(f"Join {NAME} group")
    phone._screen.side_effect = Screens([button], [button], [button],
                                        [node("Request sent", top=300, clickable=False)])
    record = asyncio.run(groups.join(candidate()))
    # The point is that Join was reached at all: the page was already open, so
    # "could not be opened" was a lie that cost the group a day.
    assert record.note != "the group could not be opened from its card"
    assert phone._tap.await_count >= 1
    assert record.join_attempts == 1


def test_a_pending_request_is_rechecked_before_fresh_candidates(tmp_path):
    # Rechecking a request costs no join, and until it flips to "joined" the group
    # can never be engaged with. Sorted by attempts alone it sat behind 1,500
    # fresh candidates and was never looked at again.
    _, _, store = driver(tmp_path)
    store.put(GroupRecord("Waiting For Approval", score=60, members=900, state="requested",
                          join_attempts=1))
    store.put(GroupRecord("Fresh Candidate", score=99, members=9000))
    assert [g.name for g in store.join_queue()] == ["Waiting For Approval", "Fresh Candidate"]


def test_a_pending_request_that_lost_its_join_returns_to_the_queue(tmp_path):
    groups, phone, store = driver(tmp_path)
    store.put(GroupRecord(NAME, state="requested", members=5800, score=87, join_attempts=1))
    phone._screen.return_value = [node(f"Join {NAME} group")]
    record = asyncio.run(groups.join(candidate()))
    # The Join control is back, so the request was declined or withdrawn: flip it
    # to a candidate instead of reading it as pending forever and never tapping
    # again (that is how a group could sit in "requested" for days).
    assert record.state == "candidate"
    assert record.join_attempts == 0
    assert "gone" in record.note
    phone._tap.assert_not_awaited()


class Screens:
    """A fake phone screen: the next page per read, the last one repeating."""

    def __init__(self, *pages):
        self.pages = [list(page) for page in pages]

    def __call__(self):
        return self.pages.pop(0) if len(self.pages) > 1 else self.pages[0]


def test_join_retry_budget_and_unverified_suggestions_are_excluded(tmp_path):
    _, _, store = driver(tmp_path)
    store.put(GroupRecord("query suggestion", score=90))
    store.put(GroupRecord(NAME, score=87, members=5800, join_attempts=3))
    assert store.join_queue() == []


def test_a_tap_that_changed_nothing_is_looked_at_once_more(tmp_path):
    # Groups parked at "Join tapped but the state did not change" were almost
    # always sitting on a membership-questions sheet. Those are answered now.
    _, _, store = driver(tmp_path)
    store.put(GroupRecord(NAME, score=87, members=5800, state="failed",
                          note="Join tapped but the state did not change", join_attempts=1))
    assert [g.name for g in store.join_queue()] == [NAME]


def test_a_group_refused_for_questions_is_not_retried_by_a_robot(tmp_path):
    _, _, store = driver(tmp_path)
    store.put(GroupRecord(NAME, score=87, members=5800, state="refused",
                          note="membership questions need a human: What is your phone number?"))
    assert store.join_queue() == []


def test_a_search_that_lands_on_the_group_page_is_not_a_failure(tmp_path):
    # Facebook answers an exact group name by opening the group itself, and the
    # "Groups search results" chip never appears; the old code read that as a
    # failed search and gave up with the page it wanted already open.
    groups, phone, store = join_driver(tmp_path)
    groups._submit_search = AsyncMock(return_value=False)
    button = node(f"Join {NAME} group")
    phone._screen.side_effect = Screens([button], [button], [button],
                                        [node("Request sent", top=300, clickable=False)])
    record = asyncio.run(groups.join(candidate()))
    # The point is that Join was reached at all: the page was already open, so
    # "could not be opened" was a lie that cost the group a day.
    assert record.note != "the group could not be opened from its card"
    assert phone._tap.await_count >= 1
    assert record.join_attempts == 1


def test_a_pending_request_is_rechecked_before_fresh_candidates(tmp_path):
    # A request waiting for approval costs no join to recheck, and until it flips
    # to "joined" the group can never be engaged with. Sorted by attempts alone it
    # sat behind 1,500 fresh candidates and was never looked at again.
    _, _, store = driver(tmp_path)
    store.put(GroupRecord("Waiting For Approval", score=60, members=900, state="requested",
                          join_attempts=1))
    store.put(GroupRecord("Fresh Candidate", score=99, members=9000))
    assert [g.name for g in store.join_queue()] == ["Waiting For Approval", "Fresh Candidate"]




def test_cooldown_survives_a_new_driver(tmp_path):
    groups, phone, store = driver(tmp_path)
    assert asyncio.run(groups._reserve("join"))[0]
    again = FacebookGroups(phone, store, limits=FbLimits(quiet_hours=None))
    ok, why = asyncio.run(again._peek("join"))
    assert not ok and why == "join cooldown"
    assert phone.cache.count("join") == 1


# ── the membership-questions sheet ───────────────────────────────────────────
# The worker used to read the sheet as "the state did not change", mark the group
# failed for good and walk away with the modal still open, having already spent a
# join from the day's allowance. These are the shapes the sheet takes.


def questions_form(question: str, *, button: str = "Submit") -> list:
    return [
        node("Membership questions", top=150, clickable=False),
        node(question, top=250, clickable=False),
        node("", top=330, rid="com.facebook.katana:id/answer_text"),
        node(button, top=1200),
    ]


def join_driver(tmp_path):
    groups, phone, store = driver(tmp_path)
    groups._settle = AsyncMock()
    groups._enter_text = AsyncMock()
    return groups, phone, store


def test_membership_questions_are_answered_and_the_request_recorded(tmp_path):
    groups, phone, store = join_driver(tmp_path)
    button = node(f"Join {NAME} group")
    phone._screen.side_effect = Screens(
        [button],
        questions_form("Why do you want to join the group?"),
        [node("Request sent", top=300, clickable=False)],
    )
    record = asyncio.run(groups.join(candidate()))
    assert record.state == "requested"
    assert record.note.startswith("answered 1 membership question")
    # One join sent, one join counted.
    assert phone.cache.count("join") == 1
    groups._enter_text.assert_awaited_once_with(join_answer_text())
    assert store.review_queue() == []


def test_a_question_the_worker_cannot_answer_is_handed_over_and_the_sheet_closed(tmp_path):
    groups, phone, store = join_driver(tmp_path)
    button = node(f"Join {NAME} group")
    form = questions_form("What is your phone number?")
    phone._screen.side_effect = Screens([button], form)
    record = asyncio.run(groups.join(candidate()))
    assert record.state == "refused"
    assert "need a human" in record.note
    assert store.review_queue()[0]["kind"] == "join-questions"
    # Nothing was invented, nothing was requested, and the sheet was left closed.
    assert groups._enter_text.await_count == 0
    assert phone.cache.count("join") == 0
    assert phone._key.await_count >= 1
    assert not store.join_queue(now=record.retry_at + 1)


def test_a_rules_screen_is_agreed_once_and_the_request_recorded(tmp_path):
    groups, phone, store = join_driver(tmp_path)
    button = node(f"Join {NAME} group")
    rules = [node("Group rules from the admins", top=150, clickable=False),
             node("Be kind to each other.", top=250, clickable=False),
             node("Agree", top=900)]
    phone._screen.side_effect = Screens([button], rules, [node("Cancel request", top=300)])
    record = asyncio.run(groups.join(candidate()))
    assert record.state == "requested"
    assert phone.cache.count("join") == 1
    assert any(call.args[0].label == "Agree" for call in phone._tap.call_args_list)


def test_a_confirmation_dialog_is_confirmed_once(tmp_path):
    groups, phone, store = join_driver(tmp_path)
    button = node(f"Join {NAME} group")
    dialog = [node("Join group", top=900), node("Cancel", top=900)]
    phone._screen.side_effect = Screens([button], dialog, [node("Cancel request", top=300)])
    record = asyncio.run(groups.join(candidate()))
    assert record.state == "requested"
    assert phone.cache.count("join") == 1


def test_a_describe_yourself_question_picks_the_business_option(tmp_path):
    groups, phone, store = join_driver(tmp_path)
    button = node(f"Join {NAME} group")
    form = [
        node("Membership questions", top=150, clickable=False),
        node("Which of these best describes you?", top=250, clickable=False),
        node("Parent", top=330),
        node("Business owner", top=390),
        node("Submit", top=1200),
    ]
    phone._screen.side_effect = Screens([button], form,
                                        [node("Request sent", top=300, clickable=False)])
    record = asyncio.run(groups.join(candidate()))
    assert record.state == "requested"
    assert any(call.args[0].label == "Business owner" for call in phone._tap.call_args_list)
    # A choice was tapped, not a fact invented.
    assert groups._enter_text.await_count == 0


def test_a_sheet_is_scrolled_once_before_it_is_given_up_on(tmp_path):
    groups, phone, store = join_driver(tmp_path)
    button = node(f"Join {NAME} group")
    top = [node("Membership questions", top=150, clickable=False),
           node("What is your phone number?", top=250, clickable=False),
           node("", top=330, rid="com.facebook.katana:id/answer_text")]
    # The sheet's Submit is below the fold until the sheet is scrolled.
    scrolled = top + [node("Submit", top=1150)]
    phone._screen.side_effect = Screens([button], top, scrolled)
    record = asyncio.run(groups.join(candidate()))
    assert record.state == "refused"
    phone._swipe.assert_awaited()  # it reached for the button before giving up
    assert phone.cache.count("join") == 0
    assert store.review_queue()[0]["kind"] == "join-questions"


def test_a_checkpoint_while_answering_leaves_the_group_retryable(tmp_path):
    groups, phone, store = join_driver(tmp_path)
    groups._guard = AsyncMock(side_effect=["", "the phone is paused after a security check"])
    button = node(f"Join {NAME} group")
    phone._screen.side_effect = Screens([button], questions_form("Why do you want to join?"))
    record = asyncio.run(groups.join(candidate()))
    # Not a dead end: the group is queued again once the phone is usable.
    assert record.state == "candidate"
    assert "security check" in record.note
    assert record in store.join_queue(now=record.retry_at + 1)
    assert phone.cache.count("join") == 0


def test_a_join_that_changes_nothing_is_still_a_failure_and_costs_nothing(tmp_path):
    groups, phone, store = join_driver(tmp_path)
    button = node(f"Join {NAME} group")
    phone._screen.side_effect = Screens([button], [button])
    record = asyncio.run(groups.join(candidate()))
    assert record.state == "failed"
    assert phone.cache.count("join") == 0
    assert store.review_queue()[0]["kind"] == "join-unverified"


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
