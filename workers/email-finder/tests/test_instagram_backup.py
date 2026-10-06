"""Instagram as the backup when Facebook has no address, built on the profiles
the user shared on 2026-10-04 (thegrindbjj, warriormartialarts1, uskasdofficial,
americancombatacademy). No network, no browser: fixtures mirror the markup
Instagram served those profiles in iPhone emulation."""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.engine import Engine, Row, _Job, _facebook_handle, _profile_links
from email_finder.extract import parse_page
from email_finder.fetch import Fetcher, IG_SETTLE_MS, Page, instagram_profile_url
from email_finder.cache import Cache

# warriormartialarts1, after "... and 2 more" was opened: Instagram wraps every
# website in l.instagram.com and also links its Threads/Facebook pages and footer.
WARRIOR_IG = """<html><body><main>
<h2>warriormartialarts1</h2><span>Warrior Martial Arts</span><span>Martial Arts School</span>
<span>Helping kids, teens &amp; adults rise through martial arts. Elk Grove, CA</span>
<div role="dialog">
 <a href="https://l.instagram.com/?u=https%3A%2F%2Fwarriormartialartselkgrove.com%2Fwarrior-parent-guide%2F&amp;e=AT0x">Warrior Parent Guide</a>
 <a href="https://l.instagram.com/?u=https%3A%2F%2Fwww.warriormartialartselkgrove.com%2F%3Futm_source%3Dig&amp;e=AT0y">Website</a>
 <a href="https://www.facebook.com/107408974782307?ref=PROFILE_EDIT_xav_ig_profile">Warrior Martial Arts Facebook</a>
</div>
<a href="https://www.threads.com/@warriormartialarts1">threads</a>
</main><footer><a href="https://www.instagram.com/web/lite/">Contact Uploading &amp; Non-Users</a>
<a href="https://about.meta.com/">Meta</a><a href="https://help.instagram.com/">Help</a></footer></body></html>"""

GRIND_SITE_CONTACT = """<html><body><h1>The Grind Martial Arts Academy</h1>
<p>937 E. Bardsley Ave, Tulare, CA 93274</p><a href="mailto:thegrindbjj54@gmail.com">Email us</a></body></html>"""


def test_share_tokens_are_dropped_from_instagram_links():
    assert instagram_profile_url("https://www.instagram.com/thegrindbjj?stkn=Ymg2bHJrajl6bnIy") == \
        "https://www.instagram.com/thegrindbjj/"
    assert instagram_profile_url("https://www.instagram.com/americancombatacademy?stkn=MTJp==") == \
        "https://www.instagram.com/americancombatacademy/"


def test_profile_links_unwraps_instagrams_link_shim_and_skips_meta_pages():
    links = _profile_links(parse_page("https://www.instagram.com/warriormartialarts1/", WARRIOR_IG))
    assert links == ["https://warriormartialartselkgrove.com/warrior-parent-guide/",
                     "https://www.warriormartialartselkgrove.com/?utm_source=ig"]


def test_facebook_handles_worth_trying_on_instagram():
    assert _facebook_handle("https://www.facebook.com/gbsouthatx/") == "gbsouthatx"
    assert _facebook_handle("https://www.facebook.com/profile.php?id=100075447356523") is None
    assert _facebook_handle("https://www.facebook.com/pages/Some-Dojo/123") is None
    assert _facebook_handle("https://www.facebook.com/107408974782307") is None
    assert _facebook_handle("https://www.facebook.com/policy.php/") is None
    assert _facebook_handle("facebook.com/policy.php/") is None


# ── the engine never stops at a Facebook page without an address ───────────


class _Sites:
    """Fetcher stand-in: Facebook without an address, Instagram as captured,
    and the websites Instagram links to."""
    use_browser = False

    def __init__(self, instagram: dict[str, str], sites: dict[str, str]):
        self.instagram, self.sites, self.asked = instagram, sites, []

    async def fetch_fb_profile(self, url):
        self.asked.append(url)
        return Page(url, 200, "<p>Warrior Martial Arts. Classes for kids and adults.</p>", url, False, via="iphone")

    async def fetch_ig_profile(self, url):
        self.asked.append(url)
        html = self.instagram.get(url)
        return Page(url, 200, html, url, False, via="iphone") if html else None

    async def get(self, url):
        self.asked.append(url)
        for prefix, html in self.sites.items():
            if url.split("?")[0].rstrip("/").startswith(prefix.rstrip("/")):
                return Page(url, 200, html, url, False)
        return None

    async def render(self, url):
        return None

    def social_paused(self, platform):
        return 0


class _Domains:
    async def accepts_mail(self, domain):
        return True


class _NoSearch:
    enabled = False


def _job(fetcher, **row):
    return _Job(Engine(fetcher, _NoSearch(), _Domains()), Row(**row))  # type: ignore[arg-type]


def test_instagram_is_the_backup_when_facebook_has_no_address():
    site = "<h1>Warrior Martial Arts Elk Grove</h1><p>Elk Grove, CA</p><a href='mailto:info@warriormartialartselkgrove.com'>x</a>"
    fetcher = _Sites({"https://www.instagram.com/warriormartialarts1/": WARRIOR_IG},
                     {"https://www.warriormartialartselkgrove.com/": site,
                      "https://warriormartialartselkgrove.com/": site})
    job = _job(fetcher, title="Warrior Martial Arts", address="Elk Grove, CA 95624",
               facebook="https://www.facebook.com/warriormartialarts1", instagram="")
    job.social = {"https://www.facebook.com/warriormartialarts1"}

    async def run():
        await job._scrape_social_profiles()
        best = await job._decide()
        await job._finish(best)
    asyncio.run(run())
    # Facebook first, then the same handle on Instagram, then its website.
    assert fetcher.asked[0] == "https://www.facebook.com/warriormartialarts1"
    assert fetcher.asked[1] == "https://www.instagram.com/warriormartialarts1/"
    assert job.finding.email == "info@warriormartialartselkgrove.com"
    assert job.finding.method.endswith("(found via the school's Instagram profile)")


def test_a_guessed_instagram_handle_that_is_someone_else_is_not_used():
    stranger = "<h2>gbsouthatx</h2><span>Gabriela's travel photos</span>" \
               "<a href='https://l.instagram.com/?u=https%3A%2F%2Fgabi-travels.example%2F'>blog</a>"
    fetcher = _Sites({"https://www.instagram.com/gbsouthatx/": stranger}, {})
    job = _job(fetcher, title="Gracie Barra South Austin", address="8204 Brodie Ln, Austin, TX 78745")
    job.social = {"https://www.facebook.com/gbsouthatx"}
    asyncio.run(job._scrape_social_profiles())
    assert "https://www.instagram.com/gbsouthatx/" in fetcher.asked
    assert not any("gabi-travels" in u for u in fetcher.asked)


def test_a_javascript_only_contact_page_is_rendered_even_with_other_candidates():
    rendered = []

    class JsSite(_Sites):
        use_browser = True

        async def render(self, url):
            rendered.append(url)
            if url.rstrip("/").endswith("/contact"):
                return Page(url, 200, GRIND_SITE_CONTACT, url, False, via="browser")
            return None

    plain_home = "<h1>The Grind</h1><a href='/contact'>Contact</a>" + "<p>schedule</p>" * 40
    fetcher = JsSite({}, {"https://www.thegrindbjj.com/": plain_home,
                          "https://www.thegrindbjj.com/contact": "<div id=app></div>"})
    job = _job(fetcher, title="The Grind Martial Arts Academy", address="937 E. Bardsley Ave, Tulare, CA 93274")
    job.candidates += parse_page("https://www.instagram.com/x/", "<p>press@instagram-ish.example</p>").candidates
    asyncio.run(job._crawl_site("https://www.thegrindbjj.com/"))
    assert any(u.endswith("/contact") for u in rendered)
    assert "thegrindbjj54@gmail.com" in {c.email for c in job.candidates}


# ── the 3-second Contact routine ─────────────────────────────────────────────


class _Locator:
    def __init__(self, page, name):
        self.page, self.name = page, name

    async def count(self):
        return 1 if self.name in self.page.buttons() else 0

    @property
    def first(self):
        return self

    async def is_visible(self):
        return True

    async def click(self, timeout=0):
        self.page.clicked.append(self.name)


class _Text:
    def __init__(self, page, pattern):
        self.page, self.pattern = page, pattern

    async def count(self):
        shown = self.page.not_found_until is not None and self.page.reloads < self.page.not_found_until
        return 1 if shown and self.pattern.search("Sorry, this page isn't available.") else 0


class _IgPage:
    """Instagram profile stand-in: the Contact button shows up only after
    `button_after_reload` reloads (None: never)."""

    def __init__(self, button_after_reload, not_found_until=None):
        self.button_after_reload, self.reloads, self.waits, self.clicked = button_after_reload, 0, [], []
        self.not_found_until = not_found_until  # "page isn't available" until this many reloads

    def buttons(self):
        shown = {"Follow", "Message", "Contact Uploading & Non-Users"}
        if self.button_after_reload is not None and self.reloads >= self.button_after_reload:
            shown.add("Contact")
        return shown

    def get_by_role(self, role, name, exact=False):
        return _Locator(self, name)

    def get_by_text(self, pattern):
        return _Text(self, pattern)

    async def wait_for_timeout(self, ms):
        self.waits.append(ms)

    async def reload(self, **kw):
        self.reloads += 1


def test_contact_button_found_on_first_load_is_opened():
    page = _IgPage(button_after_reload=0)
    assert asyncio.run(Fetcher(Cache(Path(":memory:")))._instagram_contact(page)) is True
    assert page.clicked == ["Contact"] and page.reloads == 0 and page.waits[0] == IG_SETTLE_MS


def test_no_contact_button_within_3_seconds_refreshes_once_then_moves_on(tmp_path):
    late = _IgPage(button_after_reload=1)
    assert asyncio.run(Fetcher(Cache(tmp_path / "a.db"))._instagram_contact(late)) is True
    assert late.reloads == 1 and late.clicked == ["Contact"]

    never = _IgPage(button_after_reload=None)
    assert asyncio.run(Fetcher(Cache(tmp_path / "b.db"))._instagram_contact(never)) is False
    assert never.reloads == 1  # one refresh, then on to the next source
    assert never.waits.count(IG_SETTLE_MS) == 2
    assert "Contact Uploading & Non-Users" not in never.clicked


def test_a_free_mail_inbox_named_after_the_schools_own_site_is_accepted():
    from email_finder.extract import Candidate
    job = _job(_Sites({}, {}), title="The Grind Martial Arts Academy", address="937 E. Bardsley Ave, Tulare, CA 93274")
    job.site_host, job.site_domain, job.site_is_schools = "thegrindbjj.com", "thegrindbjj.com", True
    context = "Our location Address: 937 E. Bardsley Ave, Tulare, CA 93274 Phone: 559-759-8024 Email: thegrindbjj54@gmail.com"
    own = job._score("thegrindbjj54@gmail.com",
                     [Candidate("thegrindbjj54@gmail.com", "mailto", "https://www.thegrindbjj.com/contact", context)], [], False)
    other = job._score("coach.mike@gmail.com",
                       [Candidate("coach.mike@gmail.com", "mailto", "https://www.thegrindbjj.com/contact",
                                  context.replace("thegrindbjj54", "coach.mike"))], [], False)
    assert own.score >= job.e.scoring.minimum_score and own.kind == "business"
    assert own.score - other.score >= 10


def test_a_robots_txt_bot_wall_is_not_a_crawl_ban(tmp_path, monkeypatch):
    import httpx
    import email_finder.fetch as fetch_module

    async def public(url):
        return True
    monkeypatch.setattr(fetch_module, "public_url", public)
    answers = {"walled.example": 403, "down.example": 503, "busy.example": 429}

    async def run():
        f = Fetcher(Cache(tmp_path / "c.db"))
        await f._client.aclose()
        f._client = httpx.AsyncClient(transport=httpx.MockTransport(
            lambda r: httpx.Response(answers[r.url.host], text="<html>Forbidden</html>")))
        result = {host: await f.allowed(f"https://{host}/contact") for host in answers}
        await f.close()
        return result
    assert asyncio.run(run()) == {"walled.example": True, "down.example": False, "busy.example": False}


def test_a_missing_instagram_page_gets_two_tries_in_the_browser(tmp_path):
    gone = _IgPage(button_after_reload=None, not_found_until=99)
    assert asyncio.run(Fetcher(Cache(tmp_path / "a.db"))._instagram_contact(gone)) is False
    assert gone.reloads == 1  # tried twice, then moved on
    hiccup = _IgPage(button_after_reload=1, not_found_until=1)
    assert asyncio.run(Fetcher(Cache(tmp_path / "b.db"))._instagram_contact(hiccup)) is True
