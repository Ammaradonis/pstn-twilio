"""Reading a Facebook screen, and typing into it safely.

Replayed screens only: no phone, no adb, no network. The nodes are built by hand
so the geometry a real dump produces can be tested without one, which is the part
that actually decides whether a comment lands in the right box.
"""

import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.android import Node
from email_finder.fb_vocab import term_key
from email_finder.fb_groups import (
    GroupRecord,
    GroupStore,
    FacebookGroups,
    bands,
    card_name,
    challenge_kind,
    clean_text,
    comment_rows,
    composer,
    composer_closed,
    group_card,
    group_rows,
    input_text_arg,
    join_control,
    looks_published,
    post_rows,
    sanitize,
    submit_control,
    visible,
)

FB = "com.facebook.katana"
MESSENGER = "com.facebook.orca"


def node(text: str = "", desc: str = "", rid: str = "", clickable: bool = False,
         bounds: tuple[int, int, int, int] = (0, 0, 720, 80), package: str = FB,
         selected: bool = False) -> Node:
    left, top, right, bottom = bounds
    return Node(text, desc, rid, package, clickable,
                ((left + right) // 2, (top + bottom) // 2), bounds, selected)


def card_nodes(top: int, name: str, members: str, privacy: str = "Public group") -> list[Node]:
    return [
        node(text=name, clickable=True, bounds=(40, top, 620, top + 40)),
        node(text=members, bounds=(40, top + 46, 300, top + 70)),
        node(text=privacy, bounds=(40, top + 74, 220, top + 98)),
    ]


# ── search results ───────────────────────────────────────────────────────────


def test_a_group_card_yields_its_name_members_and_privacy():
    nodes = card_nodes(300, "Martial Arts School Owners", "12.4K members", "Private group")
    nodes += card_nodes(560, "Austin Small Business Owners", "3,201 members")
    found = group_rows(nodes)
    names = [candidate.name for candidate in found]
    assert names == ["Martial Arts School Owners", "Austin Small Business Owners"]
    assert found[0].members == 12_400
    assert found[0].privacy == "private"
    assert found[1].members == 3_201


def test_a_card_with_no_word_like_a_group_is_ignored():
    nodes = [node(text="People also search for", clickable=True, bounds=(40, 900, 400, 940))]
    assert group_rows(nodes) == []


# The three tests below use labels copied verbatim from the Galaxy A20e, because
# Facebook puts a whole result card in one accessibility string and the first
# parser (written from memory) read none of them.


def test_the_real_group_card_layout_is_parsed():
    nodes = [
        node(text="JIU-JITSU EVERYTHING,Public \u00b7 85K members \u00b7 10+ posts a day",
             clickable=True, bounds=(40, 300, 680, 380)),
        node(text="Join", clickable=True, bounds=(560, 390, 680, 440)),
        node(text="TNT Taekwondo,Public \u00b7 275 members", clickable=True,
             bounds=(40, 470, 680, 540)),
        node(text="Korean Martial Arts,Public \u00b7 2.2K members \u00b7 3 posts a day",
             clickable=True, bounds=(40, 610, 680, 680)),
    ]
    rows = group_rows(nodes)
    assert [row.name for row in rows] == ["JIU-JITSU EVERYTHING", "TNT Taekwondo",
                                          "Korean Martial Arts"]
    assert rows[0].members == 85_000 and rows[0].privacy == "public"
    assert rows[1].members == 275
    # A martial arts group with no "owners"/"community" in its name still scores
    # as a martial arts group, and is worth joining on that alone.
    assert rows[2].kind == "martial-arts"


def test_a_page_result_is_not_a_group():
    # Pages sit on the same search screen and say "followers", not "members".
    nodes = [node(text="Life Ki-do Martial Arts & Personal Development\uFFFC\uFFFC "
                       "Martial Arts School \u00b7 1.9K followers", clickable=True,
                  bounds=(40, 300, 680, 380))]
    assert group_rows(nodes) == []


def test_the_filter_chips_are_not_groups():
    nodes = [
        node(text="Groups search results", clickable=True, bounds=(40, 200, 400, 240)),
        node(text="Pages search results", clickable=True, bounds=(420, 200, 680, 240)),
    ]
    assert group_rows(nodes) == []


def test_the_group_name_is_cut_out_of_the_card_text():
    assert card_name("TNT Taekwondo,Public \u00b7 275 members") == "TNT Taekwondo"
    assert card_name("Korean Martial Arts,Public \u00b7 2.2K members \u00b7 3 posts a day") \
        == "Korean Martial Arts"
    assert card_name("Private \u00b7 12 members") == "Private"


def test_a_card_can_be_found_to_tap_when_it_has_no_url():
    nodes = [node(text="TNT Taekwondo,Public \u00b7 275 members", clickable=True,
                  bounds=(40, 300, 680, 380))]
    found = group_card(nodes, "TNT Taekwondo")
    assert found is not None and found.clickable
    assert group_card(nodes, "A Group We Did Not Search For") is None


def test_a_joinable_group_is_recognised():
    nodes = [node(text="Join", clickable=True, bounds=(500, 300, 680, 350))]
    control, state = join_control(nodes)
    assert control is not None and state == "joinable"


@pytest.mark.parametrize("label,expected", [("Requested", "requested"), ("Joined", "joined"),
                                            ("Cancel request", "cancel request")])
def test_an_already_actioned_group_is_recognised(label, expected):
    nodes = [node(text=label, clickable=True, bounds=(500, 300, 680, 350))]
    control, state = join_control(nodes)
    assert control is None and state == expected


def test_no_join_control_at_all():
    assert join_control([node(text="About", bounds=(0, 0, 100, 40))]) == (None, "")


# ── the feed ─────────────────────────────────────────────────────────────────


def test_a_post_is_read_with_its_author():
    nodes = [
        node(text="Coach Dan", clickable=True, bounds=(40, 300, 300, 340)),
        node(text="We keep missing calls between six and eight in the evening and I have "
                  "no idea how many parents just ring the next school.",
             bounds=(40, 345, 680, 420)),
        node(desc="Like", clickable=True, bounds=(40, 430, 120, 470)),
        node(desc="Comment", clickable=True, bounds=(140, 430, 220, 470)),
        node(desc="Share", clickable=True, bounds=(240, 430, 320, 470)),
    ]
    posts = post_rows(nodes)
    assert len(posts) == 1
    author, body = posts[0]
    assert author == "Coach Dan"
    assert body.startswith("We keep missing calls")


def test_a_short_band_is_not_a_post():
    nodes = [node(text="Like", desc="Like", clickable=True, bounds=(40, 300, 120, 340)),
             node(text="Monday class was good.", bounds=(40, 345, 680, 380))]
    assert post_rows(nodes) == []


def test_a_comment_is_read_with_its_own_reply_control():
    nodes = [
        node(text="Jamie Ruiz", clickable=True, bounds=(60, 500, 300, 530)),
        node(text="Just answer the phone, it is not complicated to do.",
             bounds=(60, 535, 660, 570)),
        node(text="Reply", clickable=True, bounds=(60, 575, 140, 610)),
    ]
    comments = comment_rows(nodes)
    assert len(comments) == 1
    author, text, reply = comments[0]
    assert author == "Jamie Ruiz" and text.startswith("Just answer the phone")
    assert reply is not None and reply.label == "Reply"


def test_a_band_is_capped_so_a_post_cannot_swallow_the_screen():
    nodes = [node(text=f"line {i}", bounds=(40, 300 + i * 30, 680, 320 + i * 30))
             for i in range(20)]
    clamped = bands(visible(nodes), gap=20, max_height=200)
    assert len(clamped) > 1


def test_nodes_off_the_screen_are_not_read():
    nodes = [node(text="Join", clickable=True, bounds=(500, 300, 500, 300))]
    assert visible(nodes) == []


# ── typing ───────────────────────────────────────────────────────────────────


def test_the_sanitizer_removes_what_could_reach_the_shell():
    assert sanitize('Hello & welcome | to the club; rm -rf $HOME `now` "quoted"') == \
        "Hello welcome to the club rm -rf HOME now quoted"


def test_newlines_become_spaces_so_the_comment_is_not_sent_early():
    assert sanitize("First line.\nSecond line.\r\nThird.") == "First line. Second line. Third."


def test_smart_punctuation_is_normalised_and_quotes_are_dropped():
    # Curly quotes become straight ones and are then removed with the other
    # shell-unsafe characters: `input text` is a shell command, not a text field.
    assert sanitize("\u2019quoted\u2019 \u2014 and \u201cmore\u201d\u2026") == \
        "quoted - and more..."


def test_the_ui_automator_path_keeps_the_quotes_that_make_it_read_like_a_person():
    text = 'DM me "price script" and I\u2019ll send it \u2014 it is 3 lines.'
    assert clean_text(text) == 'DM me "price script" and I\'ll send it - it is 3 lines.'


def test_both_typing_paths_flatten_newlines():
    for clean in (sanitize, clean_text):
        assert "\n" not in clean("one\ntwo\r\nthree")


def test_both_typing_paths_cut_long_text_at_a_word_boundary():
    for clean in (sanitize, clean_text):
        out = clean("word " * 500, limit=80)
        assert len(out) <= 81 and out.endswith(".") and "wor." not in out


def test_a_long_comment_is_cut_at_a_word_boundary():
    out = sanitize("word " * 500, limit=80)
    assert len(out) <= 81
    assert out.endswith(".")
    assert "wor." not in out


def test_spaces_become_percent_s_for_input_text():
    assert input_text_arg("price script") == "price%sscript"


def test_a_published_comment_is_recognised_on_the_screen():
    text = "Call your own school at 6:40 tonight and listen to what a parent gets."
    after = [node(text="Call your own school at 6:40 tonight and listen to what a parent "
                       "gets. Most owners have never done it.", bounds=(40, 600, 680, 700))]
    assert looks_published(after, text)


def test_an_unsent_comment_is_not_recognised():
    assert not looks_published([node(text="Something else entirely")], "Our comment text")


# ── composer plumbing ────────────────────────────────────────────────────────


def test_the_composer_is_found_by_its_edit_text_rid():
    nodes = [node(text="", rid=f"{FB}:id/comment_composer_edit_text", clickable=True,
                  bounds=(40, 900, 680, 960))]
    assert composer(nodes) is not None


def test_the_composer_is_found_by_its_prompt_when_the_rid_moves():
    nodes = [node(text="Write a comment...", clickable=True, bounds=(40, 900, 680, 960))]
    assert composer(nodes) is not None


def test_the_submit_control_is_found():
    nodes = [node(text="Post", clickable=True, bounds=(600, 1400, 700, 1460))]
    assert submit_control(nodes) is not None


def test_a_closed_composer_is_detected():
    open_nodes = [node(text="Write a comment...", clickable=True, bounds=(40, 900, 680, 960))]
    assert composer_closed(open_nodes, [node(text="Feed")])
    assert not composer_closed(open_nodes, open_nodes)


def test_a_security_check_is_recognised():
    assert challenge_kind([node(text="Security check required")]) == "challenge"


def test_a_login_screen_is_only_a_login():
    assert challenge_kind([node(text="Log in to continue")]) == "login"


def test_a_ordinary_screen_is_neither():
    assert challenge_kind([node(text="Martial Arts School Owners")]) == ""


# ── the registry ─────────────────────────────────────────────────────────────


class FakeCache:
    def __init__(self) -> None:
        self.kv: dict[tuple[str, str], object] = {}
        self.counters: dict[str, int] = {}

    def get(self, ns: str, key: str):
        return self.kv.get((ns, key))

    def set(self, ns: str, key: str, value, ttl: float) -> None:
        self.kv[(ns, key)] = value

    def count(self, name: str) -> int:
        return self.counters.get(name, 0)

    def reserve(self, name: str, limit: int) -> bool:
        used = self.counters.get(name, 0)
        if limit > 0 and used >= limit:
            return False
        self.counters[name] = used + 1
        return True


def test_a_group_survives_a_restart():
    cache = FakeCache()
    store = GroupStore(cache)
    store.put(GroupRecord(name="Martial Arts School Owners", state="joined", score=88))
    again = GroupStore(cache)
    assert again.get("Martial Arts School Owners").state == "joined"
    assert again.joined()[0].name == "Martial Arts School Owners"


def test_a_search_is_not_run_twice():
    store = GroupStore(FakeCache())
    key = term_key("austin martial arts", "US")
    assert not store.searched(key)
    store.mark_searched(key, found=6, kept=2)
    assert store.searched(key)
    # The same phrase in the other market is a different search.
    assert not store.searched(term_key("austin martial arts", "UK"))
    assert store.search_count() == 1


def test_the_visit_queue_prefers_the_group_left_longest():
    store = GroupStore(FakeCache())
    store.put(GroupRecord(name="old", state="joined", last_visit=0))
    store.put(GroupRecord(name="new", state="joined", last_visit=time.time()))
    store.put(GroupRecord(name="candidate", state="candidate", last_visit=0))
    names = [group.name for group in store.needs_visit()]
    assert names == ["old"]


def test_the_review_queue_keeps_what_a_human_should_see():
    store = GroupStore(FakeCache())
    store.review({"kind": "skipped-post", "why": "a death post"})
    assert store.review_queue()[0]["why"] == "a death post"


def test_engagement_state_round_trips():
    from email_finder.fb_groups import _engagement_state, _save_engagement_state

    store = GroupStore(FakeCache())
    state = _engagement_state(store)
    state.touch("Coach Dan", "we keep missing calls")
    state.remember_comment("https://x/1", "our reply")
    state.cta_used_posts.add("https://x/1")
    _save_engagement_state(store, state)
    again = _engagement_state(store)
    assert again.author_touches["Coach Dan"] == 1
    assert again.author_last_text["Coach Dan"] == "we keep missing calls"
    assert again.prior_for("https://x/1") == ["our reply"]
    assert again.cta_used_posts == {"https://x/1"}


# ── the search queue ─────────────────────────────────────────────────────────


def test_searches_are_queued_in_tier_order_and_never_repeated():
    groups = FacebookGroups.__new__(FacebookGroups)  # no phone involved
    groups.store = GroupStore(FakeCache())
    plan = {"terms": [
        {"term": "tier3 town", "tier": 3, "bucket": "owners", "country": "US",
         "place_key": "us:a", "covers": 1, "sources": []},
        {"term": "tier1 city", "tier": 1, "bucket": "martial-arts", "country": "US",
         "place_key": "us:b", "covers": 9, "sources": []},
        {"term": "tier2 town", "tier": 2, "bucket": "owners", "country": "US",
         "place_key": "us:c", "covers": 4, "sources": []},
    ]}
    queue = groups.queue_searches(plan)
    assert [term["term"] for term in queue] == ["tier1 city", "tier2 town", "tier3 town"]
    groups.store.mark_searched(term_key("tier1 city", "US"), 3, 1)
    assert [term["term"] for term in groups.queue_searches(plan)] == ["tier2 town",
                                                                     "tier3 town"]


def test_a_capped_run_still_covers_every_tier():
    groups = FacebookGroups.__new__(FacebookGroups)
    groups.store = GroupStore(FakeCache())
    plan = {"terms": [
        {"term": "a3", "tier": 3, "bucket": "owners", "country": "US",
         "place_key": "us:a", "covers": 1, "sources": []},
        {"term": "a1", "tier": 1, "bucket": "owners", "country": "US",
         "place_key": "us:a", "covers": 1, "sources": []},
        {"term": "b1", "tier": 1, "bucket": "owners", "country": "US",
         "place_key": "us:b", "covers": 1, "sources": []},
    ]}
    queue = groups.queue_searches(plan, limit=1)
    assert [term["term"] for term in queue] == ["a1", "a3"]
