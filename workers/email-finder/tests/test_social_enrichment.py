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


def test_handle_guesses_skip_the_network_and_lone_common_words():
    # The website cell held the school's Facebook page, whose label is "facebook".
    assert "facebook" not in candidate_handles("Poole Ki Aikido Club",
                                               "https://www.facebook.com/PooleKiAikido")
    handles = candidate_handles("Tiger Rock Martial Arts", None)
    assert "tiger" not in handles and "tigerrock" in handles
    # A name of one word is still its own guess.
    assert candidate_handles("Satori", None) == ["satori"]


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


class _RefusingPhone:
    """The Galaxy at its daily limit (or paused, with `wait`): it refuses every lookup."""

    def __init__(self, wait: float = 0.0):
        self.wait, self.asked = wait, []

    def ready_in(self, app):
        return self.wait

    async def available(self):
        return True

    async def instagram(self, handle):
        from email_finder.android import AppLookup
        self.asked.append(handle)
        return AppLookup(blocked="daily limit")

    async def facebook(self, url):
        from email_finder.android import AppLookup
        self.asked.append(url)
        return AppLookup(blocked="daily limit")


def _phone_job(galaxy, **row_values):
    row = _StubRow()
    for name, value in row_values.items():
        setattr(row, name, value)
    engine = object.__new__(Engine)
    engine.galaxy = galaxy
    return engine_module._Job(engine, row, social_only=True)


def test_found_links_are_not_held_back_when_the_phone_refuses():
    """784 rows in a day and a half had found their Facebook or Instagram link
    and were deferred anyway, unwritten, because the phone could not re-read it."""
    from email_finder.worker import to_result

    phone = _RefusingPhone()
    job = _phone_job(phone, phone="")  # no number yet, so the profile is opened
    job.social = {"https://www.instagram.com/nevadashotokan/"}
    job.finding.enrichment["facebookUrl"] = "https://www.facebook.com/nevadashotokan"
    asyncio.run(job._enrich_phone_discovery())
    assert phone.asked[0] == "nevadashotokan"
    result = to_result("row", job.finding, "lease", "ENRICH")
    assert result["status"] == "FOUND" and "retryAfter" not in result


def test_known_links_are_not_reopened_once_the_row_has_a_number():
    # Opening them could add nothing this mode writes: the lookup would only
    # spend one of the phone's daily lookups.
    phone = _RefusingPhone()
    job = _phone_job(phone)
    job.social = {"https://www.instagram.com/nevadashotokan/", "https://www.facebook.com/nevadashotokan"}
    job.finding.enrichment["instagramUrl"] = "https://www.instagram.com/nevadashotokan"
    asyncio.run(job._enrich_phone_discovery())
    assert phone.asked == []


def test_a_paused_phone_is_not_handed_guesses():
    phone = _RefusingPhone(wait=12 * 3600)
    job = _phone_job(phone)
    asyncio.run(job._enrich_phone_discovery())
    assert phone.asked == [] and job.finding.retry_after is None


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


def test_every_enrichment_method_runs_to_io_without_a_name_error():
    """Each method must fail on I/O, never on a NameError.

    A missing import in `_enrich_own_site` (SIGNED_IN_HOSTS) once made every row
    log "failed" while the orchestration tests stayed green, because they stubbed
    the methods out. This executes the real bodies against an engine whose
    dependencies blow up as soon as they are used: any name the method needs but
    does not import raises NameError before that point, while an empty/absent
    dependency only raises the AttributeError the stub produces.
    """
    class Explodes:
        """Placeholder dependency: using it is fine, it just yields nothing."""

        enabled = False
        use_browser = False

        def __getattr__(self, name):
            return lambda *a, **k: None

    engine = object.__new__(Engine)
    engine.google = Explodes()
    engine.fetcher = Explodes()
    engine.galaxy = None
    engine.google_mode = "off"
    engine.search = Explodes()

    job = engine_module._Job(engine, _StubRow(), social_only=True)
    for name in ("_enrich_business_profile", "_enrich_own_site", "_enrich_web_search",
                 "_enrich_phone_discovery"):
        try:
            asyncio.run(getattr(job, name)())
        except NameError as err:  # the failure this test exists to prevent
            raise AssertionError(f"{name} uses a name it does not import: {err}") from err
        except Exception as err:  # noqa: BLE001 - I/O differences are not the point
            first = err.__class__.__name__
            assert "NameError" not in repr(err), f"{name}: {first} {err}"


def test_own_site_method_runs_with_a_sheet_facebook_url():
    """The exact call that used to raise NameError: a row whose website is a
    Facebook page goes down the SIGNED_IN_HOSTS branch."""
    row = _StubRow()
    row.website = "https://www.facebook.com/nevadashotokan"
    job = engine_module._Job(object.__new__(Engine), row, social_only=True)
    asyncio.run(job._enrich_own_site())
    assert job.finding.enrichment["facebookUrl"] == "https://www.facebook.com/nevadashotokan"
