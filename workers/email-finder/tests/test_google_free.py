"""Free Google search (google_free.py) and the engine's Google-first pass. No network."""

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.cache import Cache
from email_finder.engine import Engine, Row, _Job, _phone_variants, describe_method
from email_finder.extract import Candidate
from email_finder.google_free import GoogleBlocked, GoogleFreeSearch, GoogleUnavailable, parse_basic_html
from email_finder.search import Result


def test_basic_html_results_use_the_url_q_links():
    html = """<div><a href="/url?q=https://tigerdojo.com/contact&sa=U"><h3>Tiger Dojo</h3></a>
    <div>Austin's family dojo. Email sensei@tigerdojo.com</div></div>
    <div><a href="/url?q=https://www.yelp.com/biz/tiger-dojo&sa=U"><h3>Tiger Dojo - Yelp</h3></a>
    <div>5 reviews</div></div>
    <a href="/search?q=next">Next</a><a href="https://maps.google.com/x"><h3>Map</h3></a>"""
    results = parse_basic_html(html)
    assert [r.url for r in results] == ["https://tigerdojo.com/contact", "https://www.yelp.com/biz/tiger-dojo"]
    assert "sensei@tigerdojo.com" in results[0].snippet and "5 reviews" not in results[0].snippet
    assert {r.provider for r in results} == {"google-web"}


def test_result_links_are_resolved(tmp_path):
    google = GoogleFreeSearch(Cache(tmp_path / "c.db"))

    class Page:
        class request:
            @staticmethod
            async def get(url, max_redirects, timeout):
                assert max_redirects == 0 and "/goto?url=TOKEN" in url
                return SimpleNamespace(headers={"location": "https://www.yelp.com/biz/tiger-dojo"})

    async def run():
        assert await google._resolve(None, "/url?q=https://dojo.com/&sa=U", "") == "https://dojo.com/"
        assert await google._resolve(None, "/goto?url=TOKEN", "https://gbsouthaustin.com") == "https://gbsouthaustin.com"
        assert await google._resolve(Page(), "/goto?url=TOKEN", "https://www.yelp.com › biz") == \
            "https://www.yelp.com/biz/tiger-dojo"
        assert await google._resolve(None, "/maps/place/x", "") is None
        assert await google._resolve(None, "https://dojo.com/team", "") == "https://dojo.com/team"
        await google.close()
    asyncio.run(run())


def test_captcha_pauses_google_and_backs_off(tmp_path):
    async def run():
        google = GoogleFreeSearch(Cache(tmp_path / "c.db"), gap=(0, 0))
        browser_calls = []

        async def no_http(query, country):
            return None

        async def captcha(query, country):
            browser_calls.append(query)
            raise GoogleBlocked("Google asked for a CAPTCHA")

        google._via_http, google._via_browser = no_http, captcha
        with pytest.raises(GoogleUnavailable, match="paused for 30 min"):
            await google.search("tiger dojo")
        assert 29 * 60 < google.paused_for() <= 30 * 60
        with pytest.raises(GoogleUnavailable, match="paused, resumes"):
            await google.search("another school")
        # A real block is never retried: one attempt, then nothing is asked.
        assert browser_calls == ["tiger dojo"]

        google.cache.set("search-state", "google-pause", {"until": 0, "step": 1}, 3600)
        with pytest.raises(GoogleUnavailable, match="paused for 60 min"):
            await google.search("third school")  # a second block in a row waits longer
        assert browser_calls == ["tiger dojo", "third school"]

        async def answer(query, country):
            return [Result("https://tigerdojo.com", "Tiger Dojo", "sensei@tigerdojo.com", provider="google-web")]

        google.cache.set("search-state", "google-pause", {"until": 0, "step": 2}, 3600)
        google._via_browser = answer
        assert (await google.search("tiger dojo"))[0].url == "https://tigerdojo.com"
        assert google.cache.get("search-state", "google-pause")["step"] == 0
        google._via_browser = captcha
        assert (await google.search("tiger dojo"))[0].provider == "google-web"  # cached, not asked again
        await google.close()
    asyncio.run(run())


def test_a_slow_load_is_retried_and_never_pauses_google(tmp_path):
    """A navigation timeout is this worker's failure, not Google's: it used to
    pause every row for 30 minutes and hand the rest of the sheet to Brave."""
    async def run():
        google = GoogleFreeSearch(Cache(tmp_path / "c.db"), gap=(0, 0))
        attempts = []

        async def no_http(query, country):
            return None

        async def slow(query, country):
            attempts.append(query)
            raise GoogleUnavailable("browser search failed (TimeoutError: Page.goto: Timeout 30000ms exceeded.)")

        async def answer(query, country):
            return [Result("https://tigerdojo.com", "Tiger Dojo", "sensei@tigerdojo.com", provider="google-web")]

        google._via_http, google._via_browser = no_http, slow
        with pytest.raises(GoogleUnavailable, match="TimeoutError"):
            await google.search("slow school")
        assert attempts == ["slow school", "slow school"]  # one retry, not a pause
        assert google.paused_for() == 0

        # The next query still goes to Google rather than straight to Brave.
        google._via_browser = answer
        results = await google.search("second school")
        assert [r.url for r in results] == ["https://tigerdojo.com"]
        await google.close()
    asyncio.run(run())


def test_daily_limit(tmp_path):
    async def run():
        google = GoogleFreeSearch(Cache(tmp_path / "c.db"), daily_limit=1, gap=(0, 0))

        async def answer(query, country):
            return []

        google._via_http = answer
        assert await google.search("one") == []
        with pytest.raises(GoogleUnavailable, match="daily"):
            await google.search("two")
        await google.close()
    asyncio.run(run())


def test_phone_variants():
    assert _phone_variants("5129214950", "US") == ["(512) 921-4950", "512-921-4950", "512.921.4950"]
    assert _phone_variants("1604123456", "GB") == ["01604123456", "01604 123456"]
    assert _phone_variants("123", "US") == []


def test_method_names_the_search_that_led_to_it():
    own = {"dojo.com"}

    def m(source, url, via="", found_by=""):
        return describe_method(Candidate("a@dojo.com", source, url, "", "", via, found_by), "www.dojo.com", own)

    assert m("snippet", "https://www.yelp.com/biz/dojo", found_by="google-web") == \
        "Free Google search snippet from yelp.com"
    assert m("snippet", "https://www.yelp.com/biz/dojo", found_by="brave") == "Brave search snippet from yelp.com"
    assert m("text", "https://www.facebook.com/dojo/about_contact_and_basic_info", "iphone", "google-web") == \
        "Facebook contact info via iPhone emulation (found via free Google search)"
    assert m("directory", "https://usmaf.org/schools/dojo", found_by="brave") == \
        "Affiliation listing on usmaf.org (found via Brave search)"


# ── the engine's Google-first pass ───────────────────────────────────────────


class _Fetcher:
    use_browser = False

    async def get(self, url):
        return None

    async def render(self, url):
        return None


class _Domains:
    async def accepts_mail(self, domain):
        return True


class _Brave:
    enabled = True

    def __init__(self):
        self.queries = []

    async def search(self, q, country="US"):
        self.queries.append(q)
        return []


class _Google:
    enabled = True

    def __init__(self, results=(), blocked=False, transient=False):
        self.results, self.blocked, self.transient = list(results), blocked, transient
        self.queries = []

    async def search(self, q, country="US"):
        self.queries.append(q)
        if self.blocked:
            raise GoogleBlocked("Google asked for a CAPTCHA; paused for 30 min")
        if self.transient:
            raise GoogleUnavailable("browser search failed (TimeoutError: Page.goto: Timeout 30000ms exceeded.)")
        return self.results

    async def business_profile(self, q, country="US"):
        if self.blocked:
            raise GoogleBlocked("Google asked for a CAPTCHA; paused for 30 min")
        return None  # these rows have no Business Profile panel


ROW = dict(title="Tiger Dojo", address="1 Main St, Austin, TX 78701", phone="+1 512 921 4950")
HIT = Result("https://www.martialartsguide.org/schools/tiger-dojo", "Tiger Dojo - Austin, TX",
             "Tiger Dojo in Austin. Contact the owner: owner@tigerdojo.com", provider="google-web")


def _engine(google, brave, mode="bare"):
    return Engine(_Fetcher(), brave, _Domains(), google=google, google_mode=mode)  # type: ignore[arg-type]


def test_bare_row_is_answered_by_free_google_without_brave():
    google, brave = _Google([HIT]), _Brave()
    finding = asyncio.run(_engine(google, brave).find(Row(**ROW)))
    assert finding.email == "owner@tigerdojo.com"
    assert finding.method == "Free Google search snippet from martialartsguide.org"
    assert brave.queries == [] and finding.searches == 0
    assert any('"(512) 921-4950"' in q for q in google.queries)  # Google-only phone search
    assert any("@gmail.com" in q for q in google.queries)


def test_brave_takes_over_when_google_is_paused_or_finds_nothing():
    for google in (_Google(blocked=True), _Google([])):
        brave = _Brave()
        finding = asyncio.run(_engine(google, brave).find(Row(**ROW)))
        assert finding.email is None and brave.queries
        assert not any("@gmail.com" in q for q in brave.queries)  # Google-only queries stay on Google
    assert len(google.queries) > 1


def test_a_transient_google_failure_defers_a_bare_row_instead_of_paying_brave():
    """The whole point of the free pass: a slow page load on a row with no
    website and no social profile must not spend a Brave credit. The row waits
    for free Google instead, and the query that failed is not retried per query
    (the whole row comes back and asks Google again)."""
    google, brave = _Google(transient=True), _Brave()
    finding = asyncio.run(_engine(google, brave).find(Row(**ROW)))
    assert brave.queries == [] and finding.searches == 0
    assert finding.email is None and finding.retry_after
    assert finding.research_complete is False
    # The first Google-only query failed, so the row stopped asking Google
    # rather than issuing every remaining query into the same failure.
    assert len(google.queries) == 1


def test_brave_runs_when_free_google_says_there_are_no_results():
    """An answer of "no results" is an answer: the row is not deferred."""
    google, brave = _Google([]), _Brave()
    finding = asyncio.run(_engine(google, brave).find(Row(**ROW)))
    assert google.queries  # the free pass ran
    assert brave.queries and finding.retry_after is None


def test_rows_with_a_website_or_profile_keep_brave_first():
    job = _Job(_engine(_Google([HIT]), _Brave()), Row(**ROW))
    assert job._google_first()
    # A bare row keeps its free pass when a business profile hands it a social
    # page: the sheet row itself still names no website and no address, and
    # Google is what found that page (2026-10-07). An address candidate ends it.
    job.social.add("https://www.facebook.com/tigerdojo")
    assert job._google_first()
    job.candidates.append(Candidate(email="info@tigerdojo.com", source="site", url="https://tigerdojo.com", context=""))
    assert not job._google_first()
    job = _Job(_engine(_Google([HIT]), _Brave(), mode="all"), Row(**ROW, website="https://tigerdojo.com"))
    job.site_host = "tigerdojo.com"
    assert job._google_first()
    assert not _Job(_engine(_Google([HIT]), _Brave(), mode="off"), Row(**ROW))._google_first()
    # A row the sheet itself filled in is not a bare row: no free pass.
    filled = _Job(_engine(_Google([HIT]), _Brave()), Row(**ROW, website="https://tigerdojo.com"))
    filled.social.add("https://www.facebook.com/tigerdojo")
    assert not filled._google_first()


def test_sharing_the_fetcher_driver_lends_it_for_the_whole_page(tmp_path):
    """A lent driver isn't stopped under a search: the fetcher's browser
    shutdown used to abort the query mid-load."""
    class Fetcher:
        def __init__(self):
            self.held = 0

        async def hold_driver(self):
            self.held += 1

        async def release_driver(self):
            self.held -= 1

        async def _ensure_playwright(self):
            raise AssertionError("must not be needed: the launched tab is faked")

    async def run():
        fetcher = Fetcher()
        google = GoogleFreeSearch(Cache(tmp_path / "c.db"), fetcher=fetcher, share_fetcher_driver=True)

        held_during_tab = []

        async def tab():
            held_during_tab.append(fetcher.held)
            raise GoogleUnavailable("no tab in this test")

        google._tab = tab
        with pytest.raises(GoogleUnavailable, match="no tab"):
            await google._via_browser("tiger dojo", "US")
        assert held_during_tab == [1] and fetcher.held == 0  # released in the end
        # Without the fetcher's driver lent, nothing is touched.
        google.share_fetcher_driver, google.fetcher = False, None
        with pytest.raises(GoogleUnavailable, match="no tab"):
            await google._via_browser("tiger dojo", "US")
        assert fetcher.held == 0
        await google.close()
    asyncio.run(run())


def test_scripts_mentioning_the_captcha_page_are_not_a_captcha(tmp_path):
    """Every normal Google results page carries "/sorry/index" in its scripts."""
    page = ('<script>var s="/sorry/index?continue=";</script>'
            '<div><a href="/url?q=https://tigerdojo.com/&sa=U"><h3>Tiger Dojo</h3></a><div>Austin dojo</div></div>')
    sorry = "<p>Our systems have detected unusual traffic from your computer network.</p>"

    async def run():
        google = GoogleFreeSearch(Cache(tmp_path / "c.db"), gap=(0, 0))
        await google._client.aclose()
        google._client = httpx.AsyncClient(transport=httpx.MockTransport(
            lambda r: httpx.Response(200, text=sorry if "blocked" in str(r.url) else page)))
        assert [r.url for r in await google.search("tiger dojo")] == ["https://tigerdojo.com/"]
        with pytest.raises(GoogleUnavailable, match="CAPTCHA"):
            await google.search("blocked")
        assert google.paused_for() > 0
        await google.close()
    asyncio.run(run())


def test_only_google_search_cookies_are_loaded_from_an_export(tmp_path):
    from email_finder.google_free import load_search_cookies
    rows = [
        "# Netscape HTTP Cookie File",
        ".google.com\tTRUE\t/\tTRUE\t1893456000\tSID\tsid-value",
        "#HttpOnly_.google.com\tTRUE\t/\tTRUE\t1893456000\t__Secure-3PSID\tthird-party",
        ".google.com\tTRUE\t/\tTRUE\t1893456000\tSID\tsid-value",  # exported twice
        "www.google.com\tFALSE\t/\tFALSE\t0\tsession\tx",
        ".google.com\tTRUE\t/\tFALSE\t1000\tOLD\texpired",
        "accounts.google.com\tFALSE\t/\tTRUE\t1893456000\tLSID\tnever",
        "mail.google.com\tFALSE\t/\tTRUE\t1893456000\tOSID\tnever",
        ".paypal.com\tTRUE\t/\tTRUE\t1893456000\tsession\tnever",
        "garbage line",
    ]
    export = tmp_path / "cookies.txt"
    export.write_text("\n".join(rows), encoding="utf-8")
    cookies = {(c["domain"], c["name"]): c for c in load_search_cookies(export)}
    assert set(cookies) == {(".google.com", "SID"), (".google.com", "__Secure-3PSID"), ("www.google.com", "session")}
    assert cookies[(".google.com", "__Secure-3PSID")]["httpOnly"] is True
    assert cookies[(".google.com", "__Secure-3PSID")]["sameSite"] == "None"
    assert cookies[(".google.com", "SID")]["sameSite"] == "Lax"
    assert cookies[("www.google.com", "session")]["expires"] == -1


def test_an_export_is_imported_once_so_rotated_cookies_are_kept(tmp_path):
    export = tmp_path / "cookies.txt"
    export.write_text(".google.com\tTRUE\t/\tTRUE\t1893456000\tSID\tone\n", encoding="utf-8")
    profile = tmp_path / "profile"
    profile.mkdir()
    google = GoogleFreeSearch(Cache(tmp_path / "c.db"), profile_dir=profile, cookies_file=export)
    added = []

    class Ctx:
        async def add_cookies(self, cookies):
            added.append([c["value"] for c in cookies])

    async def run():
        await google._import_cookies(Ctx())
        await google._import_cookies(Ctx())  # the next browser session
        export.write_text(".google.com\tTRUE\t/\tTRUE\t1893456000\tSID\ttwo-new\n", encoding="utf-8")
        await google._import_cookies(Ctx())  # a fresh export
        await google.close()
    asyncio.run(run())
    assert added == [["one"], ["two-new"]]


def test_the_cse_robot_check_pauses_only_the_cse_and_is_spotted_fast(tmp_path):
    """Its results page draws a reCAPTCHA where results go (seen 2026-10-07)."""
    class CsePage:
        def __init__(self, rows, text):
            self.rows, self.text, self.url, self.polls, self.visits = rows, text, "https://cse.google.com/cse", 0, []

        async def goto(self, url, **kwargs):
            self.visits.append(url)

        async def wait_for_timeout(self, ms):
            pass

        async def evaluate(self, js):
            if "innerText" in js and "gsc" not in js:
                return self.text
            self.polls += 1
            return self.rows

    async def run():
        google = GoogleFreeSearch(Cache(tmp_path / "c.db"), gap=(0, 0), cse_id="engine")
        robot = CsePage(None, " Please verify that you are not a robot. Learn more. © 2026 Google")

        async def tab():
            return robot
        google._tab = tab
        with pytest.raises(GoogleBlocked, match="paused for 30 min"):
            await google.cse_search('"Tiger Dojo" Austin')
        assert robot.polls == 1  # stopped at the first look, not after 8 s
        assert robot.visits[-1] == "about:blank"
        assert google.paused_for() == 0  # free Google search keeps going
        with pytest.raises(GoogleBlocked, match="Programmable Search Engine paused, resumes"):
            await google.cse_search("Tiger Dojo Austin")
        assert len(robot.visits) == 2  # the paused call never loaded the page

        answer = CsePage([{"url": "https://tigerdojo.com", "title": "Tiger Dojo", "snippet": "Austin"}], "Tiger Dojo")

        async def answering_tab():
            return answer
        google._tab = answering_tab
        google.cache.set("search-state", "cse-pause", {"until": 0, "step": 3}, 3600)
        assert (await google.cse_search("Tiger Dojo Austin"))[0].url == "https://tigerdojo.com"
        assert google.cache.get("search-state", "cse-pause")["step"] == 0
        await google.close()
    asyncio.run(run())
