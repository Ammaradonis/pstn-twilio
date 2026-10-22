"""Enrichment mode: which social links count as a school's profile, how they are
normalised for the sheet, and how Engine.enrich orchestrates its methods.

No network, no browser, no phone.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from email_finder import engine as engine_module
from email_finder.engine import Engine, Row
from email_finder.social import candidate_handles, is_profile, normalise, platform_of


def test_every_sheet_platform_is_recognised():
    assert platform_of("https://www.facebook.com/dojo") == "facebook"
    assert platform_of("https://m.facebook.com/dojo") == "facebook"
    assert platform_of("https://www.instagram.com/dojo/") == "instagram"
    assert platform_of("https://youtube.com/@dojo") == "youtube"
    assert platform_of("https://youtu.be/abc") == "youtube"
    assert platform_of("https://x.com/dojo") == "twitter"
    assert platform_of("https://twitter.com/dojo") == "twitter"
    assert platform_of("https://www.linkedin.com/company/dojo") == "linkedin"
    assert platform_of("https://www.tiktok.com/@dojo") == "tiktok"
    # Not a social network at all.
    assert platform_of("https://dojo.com/contact") is None
    # A look-alike host must not pass as Facebook.
    assert platform_of("https://facebook.com.evil.example/dojo") is None


def test_the_networks_own_pages_are_not_profiles():
    # These appear in footers and search results but are never the school.
    for url in (
        "https://www.facebook.com/share.php?u=x",
        "https://www.facebook.com/policy.php",
        "https://www.facebook.com/privacy/",
        "https://www.instagram.com/explore/tags/bjj/",
        "https://www.instagram.com/accounts/login/",
        "https://www.instagram.com/legal/terms/",
        "https://youtube.com/watch?v=abc",
        "https://www.linkedin.com/feed/",
    ):
        assert not is_profile(url), url
    # Real profiles, including the numeric Facebook form.
    for url in (
        "https://www.facebook.com/nevadashotokan",
        "https://www.facebook.com/123456789/",
        "https://www.facebook.com/profile.php?id=100083472663859",
        "https://www.instagram.com/calsma_official/",
        "https://youtube.com/@dojo",
        "https://www.tiktok.com/@dojo",
    ):
        assert is_profile(url), url


def test_profile_urls_are_normalised_for_the_sheet():
    # Mobile hosts, tracking queries and the trailing slash all collapse to one
    # canonical value, so the same profile never lands in a cell twice.
    assert normalise("https://m.facebook.com/dojo/about") == "https://www.facebook.com/dojo"
    assert normalise("https://www.instagram.com/dojo/?igsh=abc") == "https://www.instagram.com/dojo"
    assert normalise("https://www.instagram.com/dojo/") == "https://www.instagram.com/dojo"
    # profile.php keeps its id.
    kept = normalise("https://www.facebook.com/profile.php?id=100083472663859")
    assert "profile.php" in kept and "id=100083472663859" in kept


def test_handle_guesses_are_plausible_instagram_handles():
    handles = candidate_handles("Nevada Shotokan Karate", "https://nevadashotokan.com")
    assert "nevadashotokan" in handles
    assert all(3 <= len(h) <= 30 for h in handles)
    # Never a guess the phone would be handed a bad handle for.
    assert all(all(c.isalnum() or c in "._" for c in h) for h in handles)
    assert candidate_handles("Calsma Taekwondo", None)[0] == "calsmataekwondo"


class _StubRow:
    title = "Nevada Shotokan"
    website = "https://nevadashotokan.com"
    address = "1 Main St, Las Vegas, NV 89101"
    phone = "+17025551234"
    category = "karate"
    facebook = ""
    instagram = ""
    shared_domain_count = 1


def test_enrichment_runs_every_method_then_stops_once_fb_and_ig_are_known():
    """Engine.enrich uses the social-only job, and its early exit works."""
    seen = {"social_only": None, "calls": []}
    real_job = engine_module._Job

    class RecordingJob(real_job):
        def __init__(self, eng, row, social_only=False):
            super().__init__(eng, row, social_only)
            seen["social_only"] = social_only

    async def panel(self):
        seen["calls"].append("panel")
        self.finding.enrichment["facebookUrl"] = "https://www.facebook.com/nevadashotokan"

    async def site(self):
        seen["calls"].append("site")
        self.finding.enrichment["youtubeUrl"] = "https://youtube.com/@nevadashotokan"

    async def search(self):
        seen["calls"].append("search")
        self.finding.enrichment["instagramUrl"] = "https://www.instagram.com/nevadashotokan/"

    async def phone(self):
        seen["calls"].append("phone")

    RecordingJob._enrich_business_profile = panel
    RecordingJob._enrich_own_site = site
    RecordingJob._enrich_web_search = search
    RecordingJob._enrich_phone_discovery = phone
    engine_module._Job = RecordingJob
    try:
        # Bypass Engine.__init__: no fetcher, search engine or phone needed.
        engine = object.__new__(Engine)
        finding = asyncio.run(RecordingJob(engine, _StubRow(), social_only=True).run())
    finally:
        engine_module._Job = real_job

    assert seen["social_only"] is True
    assert seen["calls"] == ["panel", "site", "search"]
    # Facebook and Instagram are both known, so the phone is never used.
    assert "phone" not in seen["calls"]
    assert finding.enrichment["facebookUrl"] == "https://www.facebook.com/nevadashotokan"
    assert finding.enrichment["instagramUrl"] == "https://www.instagram.com/nevadashotokan/"
    assert finding.enrichment["youtubeUrl"] == "https://youtube.com/@nevadashotokan"


def test_enrichment_keeps_a_value_the_sheet_already_had():
    """Enrichment reports what it verified even when the row already has it,
    because the API overwrites the social columns in this mode."""
    row = _StubRow()
    row.facebook = "https://www.facebook.com/old-page"
    job = engine_module._Job(object.__new__(Engine), row, social_only=True)
    job.finding.enrichment["facebookUrl"] = "https://www.facebook.com/new-page"
    job._finalize_enrichment()
    assert job.finding.enrichment["facebookUrl"] == "https://www.facebook.com/new-page"
    # The details it does not hunt are still filtered out.
    job.finding.enrichment["websiteUrl"] = "https://nevadashotokan.com"
    job._finalize_enrichment()
    assert "websiteUrl" not in job.finding.enrichment
