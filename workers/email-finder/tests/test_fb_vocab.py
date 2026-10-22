"""The address-to-search plan: every address considered, nothing invented.

No network. The Google Sheets snapshot is replaced by records built in the test,
and one test runs against the real snapshot when it exists on disk.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.fb_addresses import Address, CACHE_FILE, columns, parse_address, row_address, \
    target_parts
from email_finder.fb_vocab import (
    PLAN_FILE,
    build_places,
    build_plan,
    coverage,
    keep,
    national_terms,
    parse_members,
    phrase_budget,
    place_terms,
    score_group,
)


def record(address: str, city: str = "", country: str = "US", county: str = "",
           state: str = "", source: str = "U.S. Conquest", postcode: str = "") -> Address:
    return Address(source=source, tab="T", row=1, address=address, city=city or "Testville",
                   county=county, state_code=state, country=country, postcode=postcode)


# ── address parsing ──────────────────────────────────────────────────────────


def test_us_tail_gives_city_state_and_zip():
    parsed = parse_address("678 FM 120, Pottsboro, TX 75076", "U.S. Conquest")
    assert parsed["country"] == "US"
    assert parsed["city"] == "Pottsboro"
    assert parsed["state_code"] == "TX"
    assert parsed["postcode"] == "75076"


def test_uk_postcode_gives_town_not_the_postcode():
    parsed = parse_address("Purdy Centre, Farmhill Rd, Northampton NN3 5DS", "The Official UK")
    assert parsed["country"] == "UK"
    assert parsed["city"] == "Northampton"
    assert parsed["postcode_district"] == "NN3"


def test_uk_address_with_no_postcode_still_yields_a_town():
    parsed = parse_address("Unit 6, Wellingborough, England, UK", "The Official UK")
    assert parsed["country"] == "UK"
    assert parsed["city"] == "Unit 6"  # honest: the first part, not an invention
    assert "no postcode in address" in parsed["notes"]


def test_target_column_gives_the_county():
    assert target_parts("Grayson County, Texas, USA") == ("Grayson", "Texas")
    assert target_parts("Northamptonshire, England, UK") == ("Northamptonshire", "England")
    # A state-only locale has no county, and none is invented.
    assert target_parts("Texas, USA") == ("", "Texas")


def test_separate_columns_are_joined_like_the_api_does():
    headers = ["title", "address", "city", "state", "zip"]
    cols = columns(headers)
    row = ["A School", "12 High St", "Austin", "TX", "78701"]
    assert row_address(row, cols) == "12 High St, Austin, TX, 78701"
    # Nothing is appended twice when the address already carries it.
    row = ["A School", "12 High St, Austin, TX 78701", "Austin", "TX", "78701"]
    assert row_address(row, cols) == "12 High St, Austin, TX 78701"


# ── places and phrases ───────────────────────────────────────────────────────


def test_schools_in_one_town_collapse_into_one_place():
    places = build_places([
        record("1 A St, Austin, TX 78701", "Austin"),
        record("2 B St, Austin, TX 78702", "Austin"),
        record("3 C St, Dallas, TX 75201", "Dallas"),
    ])
    assert set(places) == {"us:austin", "us:dallas"}
    assert places["us:austin"].schools == 2
    assert len(places["us:austin"].addresses) == 2


def test_every_place_gets_a_tier_one_search():
    places = build_places([record(f"{i} Main St, Town{i}, TX 75{i:03d}", f"Town{i}")
                           for i in range(50)])
    for place in places.values():
        terms = place_terms(place)
        assert terms, place.key
        assert terms[0].tier == 1
        assert place.city.casefold() in terms[0].term


def test_phrase_budget_scales_with_the_number_of_schools():
    assert phrase_budget(1) == 5
    assert phrase_budget(1) < phrase_budget(3) < phrase_budget(10)
    # Above ten schools the full pack is used, and it stops growing there.
    assert phrase_budget(10) == phrase_budget(400) == 19


def test_no_county_means_no_county_phrase():
    places = build_places([record("1 Main St, Smalltown, TX 75001", "Smalltown")])
    place = places["us:smalltown"]
    place_terms_list = place_terms(place, budget=19)
    assert not any("county" in term.term for term in place_terms_list)


def test_uk_phrases_use_uk_words():
    places = build_places([record("1 High St, Leeds LS1 4AB", "Leeds", country="UK",
                                  county="West Yorkshire", source="The Official UK",
                                  postcode="LS1")])
    terms = place_terms(places["uk:leeds"], budget=19)
    words = " ".join(term.term for term in terms)
    assert "business owners" in words
    assert "martial arts" in words
    assert "mums" in words or "parents" in words
    assert "moms" not in words


def test_us_phrases_use_us_words_and_currency_shapes():
    places = build_places([record("1 Main St, Austin, TX 78701", "Austin", state="TX",
                                  county="Travis")])
    terms = place_terms(places["us:austin"], budget=19)
    words = " ".join(term.term for term in terms)
    assert "business owners" in words and "moms" in words
    assert "travis county" in words


# ── the plan and its ledger ──────────────────────────────────────────────────


def test_every_address_is_covered_by_a_search():
    records = [
        record("1 A St, Austin, TX 78701", "Austin"),
        record("2 B St, Dallas, TX 75201", "Dallas"),
        record("3 C St, Leeds LS1 4AB", "Leeds", country="UK", postcode="LS1",
               source="The Official UK"),
    ]
    plan = build_plan(records)
    report = coverage(records, plan)
    assert report.complete, report.missing
    assert report.covered == 3
    for item in records:
        assert plan.ledger[item.address], item.address


def test_a_blank_address_cannot_be_covered_and_says_so():
    blank = record("", "Nowhere")
    blank.reason = "row has no address"
    plan = build_plan([blank, record("1 A St, Austin, TX 78701", "Austin")])
    report = coverage([blank], plan)
    # The unusable row is excluded from coverage rather than falsely counted.
    assert report.addresses == 0
    assert report.complete


def test_the_same_phrase_from_two_towns_is_searched_once_and_its_cover_adds_up():
    records = [
        record("1 A St, Springfield, IL 62701", "Springfield"),
        record("2 B St, Springfield, MO 65801", "Springfield"),
    ]
    plan = build_plan(records)
    terms = [term.term for term in plan.terms]
    assert terms.count("springfield martial arts") == 1
    merged = next(term for term in plan.terms if term.term == "springfield martial arts")
    assert merged.covers == 2


def test_national_searches_are_not_counted_as_address_coverage():
    records = [record("1 A St, Austin, TX 78701", "Austin")]
    plan = build_plan(records)
    assert any(term.term == "martial arts school owners" for term in plan.national)
    assert not any(term.term == "martial arts school owners" for term in plan.terms)
    report = coverage(records, plan)
    assert report.terms == len(plan.terms)


def test_the_plan_is_ordered_tier_then_density():
    records = [record(f"{i} St, Bigtown, TX 7500{i}", "Bigtown") for i in range(12)]
    records += [record("9 St, Tiny, TX 75099", "Tiny")]
    plan = build_plan(records)
    ordered = plan.ordered
    assert ordered[0].tier == 1
    tiers = [term.tier for term in ordered]
    assert tiers == sorted(tiers)
    # Within tier 1, the town with twelve schools comes before the one-school town.
    first_two = [term.place_key for term in ordered if term.tier == 1][:2]
    assert first_two[0] == "us:bigtown"


def test_national_terms_cover_both_markets():
    terms = national_terms({"US", "UK"})
    assert any(term.country == "UK" for term in terms)
    assert any(term.country == "US" for term in terms)


# ── scoring what came back ───────────────────────────────────────────────────


def test_a_school_owner_group_scores_high():
    candidate = score_group("Martial Arts School Owners", None, 12_000)
    assert candidate.kind == "owners"
    assert candidate.score >= 70
    assert keep(candidate)


def test_a_buy_and_sell_group_is_refused():
    candidate = score_group("Springfield Buy Sell Swap", None, 30_000)
    assert candidate.kind == "reject"
    assert not keep(candidate)
    assert any("noise" in reason for reason in candidate.reasons)


def test_a_jobs_group_is_refused():
    assert score_group("Martial Arts Jobs UK", None, 900).kind == "reject"


def test_a_parents_group_is_kept_but_as_the_local_audience():
    found = place_terms(build_places([record("1 A St, Austin, TX 78701", "Austin")])["us:austin"])[0]
    candidate = score_group("Austin Parents", found, 8_000)
    assert candidate.kind == "local-community"
    assert candidate.score < score_group("Austin Martial Arts Owners", found, 8_000).score


def test_member_counts_parse_the_way_facebook_writes_them():
    assert parse_members("12.4K members") == 12_400
    assert parse_members("1,203 members") == 1_203
    assert parse_members("2M members") == 2_000_000
    assert parse_members("") == 0


# ── the real snapshot ────────────────────────────────────────────────────────


@pytest.mark.skipif(not CACHE_FILE.is_file(), reason="no address snapshot on this machine")
def test_the_real_workbooks_are_fully_covered():
    from email_finder.fb_addresses import load

    records = load(CACHE_FILE)
    plan = build_plan(records)
    report = coverage(records, plan)
    assert report.complete, report.missing[:5]
    assert report.addresses > 20_000
    assert report.terms > 20_000
    assert PLAN_FILE.parent.is_dir()
