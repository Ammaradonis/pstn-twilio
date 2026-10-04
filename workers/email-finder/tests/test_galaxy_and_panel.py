"""The Galaxy A20e backup (android.py) and Google Business Profile matching.
No phone and no network: screens are replayed from uiautomator-style dumps."""

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.android import Galaxy, emails_on_screen, find_button, parse_dump
from email_finder.cache import Cache
from email_finder.engine import Engine, Row, _Job, _same_address, describe_method
from email_finder.extract import Candidate
from email_finder.fetch import Page


def screen(package: str, *nodes: tuple[str, str, bool]) -> str:
    """A uiautomator dump: (text, content-desc, clickable) per node."""
    rows = "".join(
        f'<node index="{i}" text="{t}" resource-id="{package}:id/n{i}" class="android.widget.TextView" '
        f'package="{package}" content-desc="{d}" clickable="{str(c).lower()}" bounds="[0,{100 * i}][720,{100 * i + 80}]" />'
        for i, (t, d, c) in enumerate(nodes, 1))
    return f"<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\">{rows}</hierarchy>"


IG = "com.instagram.android"
PROFILE_NO_CONTACT = screen(IG, ("calsma_official", "", False), ("Follow", "", True), ("Message", "", True),
                            ("Taekwondo for kids and adults in Daly City", "", False))
PROFILE_WITH_CONTACT = screen(IG, ("calsma_official", "", False), ("Follow", "", True), ("Contact", "", True))
CONTACT_SHEET = screen(IG, ("Call", "", True), ("Email", "", True), ("Directions", "", True))
GMAIL_DRAFT = screen("com.google.android.gm", ("To", "", False), ("admin@calsma.com", "", False),
                     ("", "More options", True))


def test_reading_a_screen_dump():
    nodes = parse_dump("noise before " + PROFILE_WITH_CONTACT)
    assert find_button(nodes, "contact").center == (360, 340)
    assert emails_on_screen(parse_dump(GMAIL_DRAFT)) == ["admin@calsma.com"]
    assert parse_dump("ERROR: null root node returned by UiTestAutomationBridge.") == []


class FakePhone(Galaxy):
    """Galaxy with adb replaced by a script of screens."""

    def __init__(self, tmp_path, screens, foreground=f"{IG}/com.instagram.mainactivity.MainActivity"):
        super().__init__(Cache(tmp_path / "c.db"), "adb")
        self.screens, self.foreground, self.commands = list(screens), foreground, []

    async def available(self):
        return True

    async def _shell(self, command, timeout=25):
        self.commands.append(command)
        return ""

    async def _screen(self):
        return parse_dump(self.screens.pop(0)) if self.screens else []

    async def _foreground(self):
        return self.foreground


def _quick(monkeypatch):
    import email_finder.android as android

    async def no_wait(_):
        return None
    monkeypatch.setattr(android.asyncio, "sleep", no_wait)
    monkeypatch.setattr(android, "GAP", (0, 0))


def test_instagram_contact_button_refreshes_once_then_reads_the_draft_and_discards_it(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [PROFILE_NO_CONTACT, PROFILE_WITH_CONTACT, CONTACT_SHEET, GMAIL_DRAFT,
                                 screen("com.google.android.gm", ("Discard", "", True)),
                                 screen("com.google.android.gm", ("Discard", "", True))])
    found = asyncio.run(phone.instagram("calsma_official"))
    assert found.emails == {"admin@calsma.com": "contact"}
    swipes = [c for c in phone.commands if c.startswith("input swipe")]
    assert len(swipes) == 1  # one refresh when Contact wasn't there within 3 s
    assert any("am force-stop com.google.android.gm" == c for c in phone.commands)
    assert not any("input text" in c or "KEYCODE_ENTER" in c for c in phone.commands)  # never types or sends
    assert phone.commands[-1] == "input keyevent KEYCODE_HOME"


def test_a_challenge_screen_is_never_touched_and_pauses_the_app(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [PROFILE_WITH_CONTACT],
                      foreground=f"{IG}/com.instagram.challenge.activity.ChallengeActivity")
    found = asyncio.run(phone.instagram("calsma_official"))
    assert found.blocked and not found.emails
    assert not any(c.startswith("input tap") for c in phone.commands)
    assert phone.paused_for("instagram") > 11 * 3600
    again = asyncio.run(phone.instagram("someone_else"))
    assert again.blocked == "paused" and phone.paused_for("facebook") == 0


def test_facebook_app_reads_the_page_then_its_about_tab(tmp_path, monkeypatch):
    _quick(monkeypatch)
    fb = "com.facebook.katana"
    phone = FakePhone(tmp_path, [screen(fb, ("CALSMA Taekwondo", "", False), ("About", "", True)),
                                 screen(fb, ("Contact info", "", False), ("info@calsma.com", "", False))],
                      foreground=f"{fb}/com.facebook.katana.activity.FbMainTabActivity")
    found = asyncio.run(phone.facebook("https://www.facebook.com/calsma"))
    assert found.emails == {"info@calsma.com": "page"}


# ── the engine: the phone as the backup, and the notification's wording ─────


class _Fetcher:
    use_browser = False

    def __init__(self, ig_page=None, fb_page=None):
        self.ig_page, self.fb_page = ig_page, fb_page

    async def fetch_fb_profile(self, url):
        return self.fb_page

    async def fetch_ig_profile(self, url):
        return self.ig_page

    async def get(self, url):
        return None

    async def render(self, url):
        return None


class _Phone:
    def __init__(self, ig=None, fb=None):
        from email_finder.android import AppLookup
        self.ig, self.fb, self.asked = ig or AppLookup(), fb or AppLookup(), []

    async def instagram(self, handle):
        self.asked.append(("instagram", handle))
        return self.ig

    async def facebook(self, url):
        self.asked.append(("facebook", url))
        return self.fb


class _Domains:
    async def accepts_mail(self, domain):
        return True


class _NoSearch:
    enabled = False


def _job(fetcher, phone, **row):
    return _Job(Engine(fetcher, _NoSearch(), _Domains(), galaxy=phone), Row(**row))  # type: ignore[arg-type]


def test_galaxy_finds_what_instagrams_website_hides_and_the_method_says_so():
    from email_finder.android import AppLookup
    profile = Page("https://www.instagram.com/calsma_official/", 200,
                   "<h2>calsma_official</h2><p>California School of Martial Arts, Daly City</p>",
                   "https://www.instagram.com/calsma_official/", False, via="iphone")
    phone = _Phone(ig=AppLookup(emails={"admin@calsma.com": "contact"},
                                context="calsma_official California School of Martial Arts Contact"))
    job = _job(_Fetcher(ig_page=profile), phone, title="California School of Martial Arts",
               address="2025 Gellert Blvd Ste 203, Daly City, CA 94015")
    job.social = {"https://www.instagram.com/calsma_official/"}

    async def run():
        await job._scrape_social_profiles()
        await job._finish(await job._decide())
    asyncio.run(run())
    assert phone.asked == [("instagram", "calsma_official")]
    assert job.finding.email == "admin@calsma.com"
    assert job.finding.method == "Instagram Contact button in the app on the Galaxy A20e"


def test_facebook_blocking_the_browser_sends_the_page_to_the_phone():
    blocked = Page("https://www.facebook.com/calsma", 200, "", "https://www.facebook.com/login/", True)
    phone = _Phone()
    job = _job(_Fetcher(fb_page=blocked), phone, title="California School of Martial Arts")
    job.social = {"https://www.facebook.com/calsma"}
    asyncio.run(job._scrape_social_profiles())
    assert ("facebook", "https://www.facebook.com/calsma") in phone.asked


def test_galaxy_method_wording():
    c = Candidate("a@dojo.com", "text", "https://www.facebook.com/dojo", "", via="galaxy")
    assert describe_method(c, None, set()) == "Facebook page in the app on the Galaxy A20e"


# ── Google Business Profile ──────────────────────────────────────────────────

CALSMA_PANEL = {
    "name": "California School of Martial Arts (CALSMA TAEKWONDO)",
    "address": "2025 Gellert Blvd Ste 203, Daly City, CA 94015, United States",
    "phone": "+1 650-810-5595", "website": "http://www.calsma.com/",
    "profiles": {"facebook": "https://www.facebook.com/people/California-School-of-Martial-Arts-Calsma-Taekwondo/100083472663859/?locale=hi_IN",
                 "youtube": "https://www.youtube.com/channel/UCjhJn245sSiigT1wafmZUeA",
                 "instagram": "https://www.instagram.com/calsma_official/"},
}


def test_same_address():
    assert _same_address("2025 Gellert Blvd Ste 203, Daly City, CA 94015", CALSMA_PANEL["address"])
    assert _same_address("257 Harlestone Rd, Northampton NN5 6DD", "257 Harlestone Road, Northampton NN5 6DD, UK")
    assert not _same_address("2025 Gellert Blvd, Daly City, CA 94015", "100 Main St, Daly City, CA 94015")
    assert not _same_address("", CALSMA_PANEL["address"])


class _Google:
    enabled = True

    def __init__(self, panels):
        self.panels, self.asked = panels, []

    async def business_profile(self, query, country="US"):
        self.asked.append(query)
        return self.panels.get(query)


def _panel_job(google, **row):
    engine = Engine(_Fetcher(), _NoSearch(), _Domains(), google=google)  # type: ignore[arg-type]
    return _Job(engine, Row(**row))


CALSMA_ROW = dict(title="California School of Martial Arts", address="2025 Gellert Blvd Ste 203, Daly City, CA 94015",
                  phone="+1 (650) 810-5595", website="http://www.calsma.com")


def test_the_business_profile_gives_the_schools_own_social_pages():
    google = _Google({"California School of Martial Arts": CALSMA_PANEL})
    job = _panel_job(google, **CALSMA_ROW)
    asyncio.run(job._google_business_profile())
    assert google.asked == ["California School of Martial Arts"]  # matched on the first search
    assert "https://www.instagram.com/calsma_official/" in job.social
    assert "https://www.facebook.com/people/California-School-of-Martial-Arts-Calsma-Taekwondo/100083472663859/" in job.social
    assert not any("youtube" in u for u in job.social)


def test_a_panel_for_another_place_falls_back_to_name_plus_address():
    elsewhere = dict(CALSMA_PANEL, address="10 Market St, San Jose, CA 95113", phone="+1 408-555-0100",
                     profiles={"instagram": "https://www.instagram.com/calsma_sanjose/"})
    google = _Google({"California School of Martial Arts": elsewhere,
                      "California School of Martial Arts 2025 Gellert Blvd Ste 203, Daly City, CA 94015": CALSMA_PANEL})
    job = _panel_job(google, **CALSMA_ROW)
    asyncio.run(job._google_business_profile())
    assert len(google.asked) == 2
    assert "https://www.instagram.com/calsma_official/" in job.social
    assert "https://www.instagram.com/calsma_sanjose/" not in job.social


def test_a_google_pause_hands_over_to_brave_instead_of_waiting(tmp_path):
    from email_finder.google_free import GoogleBlocked, GoogleFreeSearch
    google = GoogleFreeSearch(Cache(tmp_path / "c.db"), gap=(0, 0))
    google.cache.set("search-state", "google-pause", {"until": time.time() + 600, "step": 1}, 3600)

    async def run():
        try:
            await google.search("anything")
        except GoogleBlocked as err:
            return str(err)
        finally:
            await google.close()
    assert "paused" in asyncio.run(run())
