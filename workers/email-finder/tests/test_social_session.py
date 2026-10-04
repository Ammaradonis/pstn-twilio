"""Signed-in Facebook/Instagram research: cookie exports, iPhone emulation and
backing off when Meta pushes back. No network, no browser."""

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.browser import IPHONE_UA, emulate_iphone
from email_finder.cache import Cache
from email_finder.cookies import FACEBOOK_HOSTS, INSTAGRAM_HOSTS, import_once, load_cookies
from email_finder.fetch import Fetcher, Page, block_kind, social_platform

FB_EXPORT = "\n".join([
    "# Netscape HTTP Cookie File",
    "#HttpOnly_.facebook.com\tTRUE\t/\tTRUE\t1893456000\txs\tsession",
    ".facebook.com\tTRUE\t/\tTRUE\t1893456000\tc_user\t100",
    ".facebook.com\tTRUE\t/\tFALSE\t0\tpresence\tp",
    ".facebook.com\tTRUE\t/\tTRUE\t1000\told\texpired",
    ".instagram.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tnot-for-facebook",
    ".evil.facebook.com.example\tTRUE\t/\tTRUE\t1893456000\tx\tnope",
])


def test_an_export_only_loads_that_sites_cookies(tmp_path):
    export = tmp_path / "www.facebook.com_cookies.txt"
    export.write_text(FB_EXPORT, encoding="utf-8")
    cookies = {c["name"]: c for c in load_cookies(export, FACEBOOK_HOSTS)}
    assert set(cookies) == {"xs", "c_user", "presence"}
    assert cookies["xs"]["httpOnly"] and cookies["presence"]["expires"] == -1
    assert [c["name"] for c in load_cookies(export, INSTAGRAM_HOSTS)] == ["sessionid"]


def test_each_export_is_imported_once(tmp_path):
    export = tmp_path / "fb.txt"
    export.write_text(FB_EXPORT, encoding="utf-8")
    added = []

    class Ctx:
        async def add_cookies(self, cookies):
            added.append(len(cookies))

    async def run():
        for _ in range(2):
            await import_once(Ctx(), export, FACEBOOK_HOSTS, tmp_path / "profile", ".cookies-imported-facebook")
    asyncio.run(run())
    assert added == [3]


def test_pushback_is_read_from_the_address_and_challenge_markers_only():
    assert block_kind("https://www.facebook.com/checkpoint/1501092823525282/", "", False) == "checkpoint"
    assert block_kind("https://www.instagram.com/challenge/AXF/", "", False) == "checkpoint"
    assert block_kind("https://www.facebook.com/login/?next=x", "", False) == "login"
    assert block_kind("https://www.instagram.com/accounts/login/?next=/dojo/", "", False) == "login"
    assert block_kind("https://www.facebook.com/tigerdojo", "", True) == "login"
    assert block_kind("https://www.facebook.com/tigerdojo", "<div>Please complete the security check</div>", False) == "captcha"
    # A post that talks about logins or suspicious activity is just a post.
    assert block_kind("https://www.facebook.com/tigerdojo/about_contact_and_basic_info",
                      "<p>Suspicious login? Our checkpoint drills start Monday.</p>", False) is None


def test_platform_of_a_url():
    assert social_platform("https://m.facebook.com/dojo") == "facebook"
    assert social_platform("https://www.instagram.com/dojo/") == "instagram"
    assert social_platform("https://facebook.com.evil.example/") is None
    assert social_platform("https://tigerdojo.com/contact") is None


def _fetcher(tmp_path, **kw):
    return Fetcher(Cache(tmp_path / "c.db"), social_cookies=kw.pop("cookies", None),
                   chrome_profile_path=str(tmp_path / "profile"), **kw)


def test_meta_pushback_pauses_that_platform_only(tmp_path):
    f = _fetcher(tmp_path)
    fb, ig = "https://www.facebook.com/dojo", "https://www.instagram.com/dojo/"
    f._social_outcome(fb, "login")
    assert 6 * 3600 - 5 < f.social_paused("facebook") <= 6 * 3600 and not f.social_paused("instagram")
    f._social_outcome(ig, "checkpoint")
    assert f.social_paused("instagram") > 11 * 3600
    f._social_outcome(fb, None)  # a normal answer lifts the pause
    assert not f.social_paused("facebook")
    f._social_outcome(fb, "captcha")
    first = f.social_paused("facebook")
    f._social_outcome(fb, "captcha")
    assert 29 * 60 < first <= 30 * 60 and f.social_paused("facebook") > 59 * 60


def test_a_paused_platform_is_not_asked_and_a_new_export_lifts_a_login_pause(tmp_path):
    export = tmp_path / "fb.txt"
    export.write_text(FB_EXPORT, encoding="utf-8")
    f = _fetcher(tmp_path, cookies={"facebook": export})
    (tmp_path / "profile").mkdir()
    stat = export.stat()
    (tmp_path / "profile" / ".cookies-imported-facebook").write_text(f"{stat.st_mtime_ns}:{stat.st_size}")
    f._social_outcome("https://www.facebook.com/dojo", "login")

    async def turn():
        return await f._social_turn("https://www.facebook.com/dojo")
    assert asyncio.run(turn()) is False
    export.write_text(FB_EXPORT + "\n", encoding="utf-8")  # the user exported again
    started = time.monotonic()
    assert asyncio.run(turn()) is True and time.monotonic() - started < 2
    assert asyncio.run(f._social_turn("https://tigerdojo.com/")) is True  # not a social page


def test_daily_page_limit(tmp_path):
    f = _fetcher(tmp_path, social_daily_limit=1)
    f._social_last["instagram"] = -1e9  # no gap to wait out in a test

    async def run():
        first = await f._social_turn("https://www.instagram.com/a/")
        f._social_last["instagram"] = -1e9
        return first, await f._social_turn("https://www.instagram.com/b/")
    assert asyncio.run(run()) == (True, False)


def test_facebook_is_not_asked_again_in_another_layout_after_pushing_back(tmp_path):
    f = _fetcher(tmp_path)
    calls = []

    async def mobile(url, labels):
        calls.append(("mobile", url))
        return Page(url, 200, "", "https://www.facebook.com/checkpoint/1/", True, via="iphone")

    async def desktop(url, labels):
        calls.append(("desktop", url))
        return None

    f._social_mobile, f._social = mobile, desktop
    page = asyncio.run(f.fetch_fb_profile("https://www.facebook.com/tigerdojo"))
    assert page.blocked and [c[0] for c in calls] == ["mobile"]


def test_iphone_emulation_covers_more_than_the_user_agent_header():
    sent, scripts = [], []

    class Cdp:
        async def send(self, method, params):
            sent.append((method, params))

    class Ctx:
        async def new_cdp_session(self, page):
            return Cdp()

    class PageStub:
        async def add_init_script(self, script):
            scripts.append(script)

    asyncio.run(emulate_iphone(Ctx(), PageStub()))
    calls = dict(sent)
    assert calls["Emulation.setUserAgentOverride"]["userAgent"] == IPHONE_UA
    assert calls["Emulation.setUserAgentOverride"]["platform"] == "iPhone"
    assert "userAgentMetadata" not in calls["Emulation.setUserAgentOverride"]  # no desktop client hints
    assert calls["Emulation.setDeviceMetricsOverride"]["mobile"] is True
    assert calls["Emulation.setTouchEmulationEnabled"]["maxTouchPoints"] == 5
    assert "userAgentData" in scripts[0]


def test_each_browser_keeps_its_own_profile_folder(tmp_path):
    from email_finder.browser import profile_for
    base = tmp_path / "google-profile"
    assert profile_for(base, "msedge") == base  # the existing folder stays Edge's
    assert profile_for(base, "chrome").name == "google-profile-chrome"
    assert profile_for(base, None).name == "google-profile-chromium"
