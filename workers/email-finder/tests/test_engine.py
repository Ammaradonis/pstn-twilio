"""Offline tests: extraction, spaCy roles, scoring rules. No network."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from email_finder import nlp  # noqa: E402
from email_finder.cache import Cache  # noqa: E402
from email_finder.engine import Engine, Row, _Job, _is_listing, _is_listing_email, _locality  # noqa: E402
from email_finder.extract import Candidate, contact_like_links, emails_in_text, parse_page  # noqa: E402
from email_finder.validate import plausible  # noqa: E402


# ── extraction ────────────────────────────────────────────────────────────────


def test_finds_plain_mailto_and_spelled_addresses():
    found = {c.email for c in emails_in_text(
        "Write to sensei [at] tigerdojo [dot] co [dot] uk, or john(at)dojo.com, or ruth.tkd AT aol.co.uk. "
        "Classes are at the hall.", "u")}
    assert found == {"sensei@tigerdojo.co.uk", "john@dojo.com", "ruth.tkd@aol.co.uk"}


def test_ignores_asset_names_and_url_encoding():
    html = '<a href="mailto:%69nfo@dojo.com?subject=hi">x</a><img src="logo@2x.png"> hero@3x.jpg'
    info = parse_page("https://dojo.com", html)
    assert [c.email for c in info.candidates if c.source == "mailto"] == ["info@dojo.com"]
    assert all("png" not in c.email and "jpg" not in c.email for c in info.candidates)


def test_reads_structured_data_and_forms():
    html = """<script type="application/ld+json">{"@type":"SportsClub","email":"owner@club.co.uk"}</script>
    <form><input type="email"><textarea></textarea></form>
    <iframe src="https://docs.google.com/forms/d/e/abc/viewform"></iframe>"""
    info = parse_page("https://club.co.uk/contact", html)
    assert "owner@club.co.uk" in {c.email for c in info.candidates}
    assert "https://club.co.uk/contact" in info.forms
    assert any("docs.google.com/forms" in f for f in info.forms)


def test_directory_row_context_includes_the_school_name():
    html = """<table><tr><td>Lopez Judo Academy</td><td>Corpus Christi</td>
    <td><a href="mailto:coach@lopezjudo.com">email</a></td></tr></table>"""
    c = parse_page("https://texasjudo.org/clubs.html", html).candidates[0]
    assert "Lopez Judo Academy" in c.context


def test_contact_pages_ranked_first():
    html = '<a href="/about-us">About</a><a href="/blog">Blog</a><a href="/contact">Contact</a>'
    links = contact_like_links(parse_page("https://dojo.com/", html), "dojo.com", 5)
    assert links[0].endswith("/contact") and all("blog" not in l for l in links)


def test_noise_and_never_mailboxes_rejected():
    for bad in ["noreply@dojo.com", "copyright@univision.com", "user@domain.com", "abc123def456abc78@sentry.io"]:
        assert not plausible(bad), bad
    assert plausible("sifu.rick@shaolinwestsa.com")


# ── spaCy roles ───────────────────────────────────────────────────────────────


def test_owner_role_and_email_owner():
    people = nlp.people("Meet Sensei John Smith, owner and head instructor. Coach Amy Lee teaches kids.")
    lead = people[0]
    assert (lead.name, lead.weight) == ("John Smith", 1.0)
    assert nlp.local_part_owner("jsmith", people).name == "John Smith"
    assert nlp.local_part_owner("john.smith", people).name == "John Smith"


def test_style_words_founders_and_streets_are_not_people():
    names = {p.name for p in nlp.people(
        "Brazilian Jiu-Jitsu was founded by Helio Gracie. Judo founder Jigoro Kano. "
        "We train on Heritage Drive. Our founder Maria Lopez opened the dojo in 2010.")}
    assert "Maria Lopez" in names
    assert not names & {"Brazilian Jiu-Jitsu", "Helio Gracie", "Jigoro Kano", "Heritage Drive"}


@pytest.mark.parametrize(
    "local,kind",
    [("info", "generic"), ("enquiries", "generic"), ("owner", "decision"), ("sifurick", "decision"),
     ("john.smith", "personal"), ("garydavis.kickboxing", "personal"), ("x9", "other")],
)
def test_local_part_classes(local, kind):
    assert nlp.classify_local(local) == kind


# ── scoring rules ─────────────────────────────────────────────────────────────


class _Stub:
    enabled = False


def _job(**row) -> _Job:
    engine = Engine(fetcher=None, search=_Stub(), domains=None)  # type: ignore[arg-type]
    return _Job(engine, Row(**row))


def test_locality_us_and_uk():
    assert _locality("678 FM 120, Pottsboro, TX 75076", "US") == ("Pottsboro", "678 FM 120")
    assert _locality("Purdy Centre, Farmhill Rd, Northampton NN3 5DS", "GB")[0] == "Northampton"


def test_designer_footer_dropped_and_owner_preferred():
    job = _job(title="Tiger Dojo", website="https://tigerdojo.com", address="1 Main St, Austin, TX 78701")
    job.site_domain, job.site_host, job.site_is_schools = "tigerdojo.com", "tigerdojo.com", True
    job.own_domains = {"tigerdojo.com"}
    people = [nlp.Person("John Smith", "owner", 1.0)]
    job._persons_cache = people
    assert job._score("hello@pixelagency.co.uk",
                      [Candidate("hello@pixelagency.co.uk", "mailto", "u", "Website designed by Pixel Agency")],
                      people, True) is None
    owner = job._score("john.smith@tigerdojo.com", [Candidate("john.smith@tigerdojo.com", "mailto", "u", "Tiger Dojo")], people, True)
    info = job._score("info@tigerdojo.com", [Candidate("info@tigerdojo.com", "mailto", "u", "Tiger Dojo")], people, True)
    assert owner.kind == "decision-maker" and info.kind == "business" and owner.score > info.score


def test_school_named_gmail_is_the_business_inbox():
    job = _job(title="Legacy Martial Arts Cove", website="https://legacymartialartscove.com")
    job.site_is_schools = True
    s = job._score("legacymartialartscove@gmail.com",
                   [Candidate("legacymartialartscove@gmail.com", "mailto", "u", "Legacy Martial Arts")], [], False)
    assert s.kind == "business"


def test_listing_pages_and_their_inboxes():
    assert _is_listing("https://dotukmap.org/details/chester-moor-boxing")
    assert _is_listing("https://www.wellnessliving.com/explore/locations/x")
    assert not _is_listing("https://chestermoorabc.co.uk/contact")
    assert _is_listing_email("mapdetailscom@gmail.com", "https://newmapuk.com/details/x")
    assert not _is_listing_email("coach@chestermoorabc.co.uk", "https://newmapuk.com/details/x")


def test_cache_counts_per_day(tmp_path):
    cache = Cache(tmp_path / "c.sqlite")
    assert cache.bump("brave") == 1 and cache.bump("brave") == 2 and cache.count("brave") == 2
    cache.set("ns", "k", {"a": 1}, ttl=60)
    assert cache.get("ns", "k") == {"a": 1}


def test_engine_never_raises_on_bad_rows():
    class Broken:
        enabled = False

    engine = Engine(fetcher=None, search=Broken(), domains=None)  # type: ignore[arg-type]
    finding = asyncio.run(engine.find(Row(title="X", website="https://example.invalid")))
    assert finding.email is None and finding.notes
