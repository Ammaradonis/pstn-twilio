"""Instagram DM outreach: lead rules, the message, Texas time, screen reading and
the send flow on a simulated phone (nothing here touches a real device)."""

from __future__ import annotations

import asyncio
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))
from email_finder.android import INSTAGRAM, Node  # noqa: E402
import ig_dm  # noqa: E402
from ig_dm import (  # noqa: E402
    Lead, Offline, Paused, Pushback, AccountProblem, Sender, Store, account_title, brand_name, build_leads, call_kind, central_offset,
    city_of, compose, composer, composer_text, first_name, handle_of, has_history, message_problems, message_shown,
    profile_message_button, pushback_on, recipient_refuses, send_button, seconds_until_window, thread_is_with,
)

HEADER = ["title", "websiteUrl", "rating", "reviewCount", "category", "address", "phoneNumber", "facebookUrl",
          "instagramUrl", "twitterUrl", "linkedinUrl", "youtubeUrl", "qualityScore", "qualityClass", "geographyValid",
          "geographyReason", "target", "placeUrl", "relevance", "businessStatus", "email", "emailType", "emailSource",
          "decisionMaker", "contactForm", "Status"]


def row(title="Lake Texoma ATA", ig="https://www.instagram.com/lake_texoma_ata/", rating="4.9", reviews="134",
        category="Martial arts school", address="678 FM 120, Pottsboro, TX 75076", dm="Kathy Snyder (owner)",
        status="", relevance="relevant", business="", quality="ACCEPT") -> list[str]:
    values = dict(title=title, instagramUrl=ig, rating=rating, reviewCount=reviews, category=category, address=address,
                  decisionMaker=dm, Status=status, relevance=relevance, businessStatus=business, qualityClass=quality)
    return [values.get(h, "") for h in HEADER]


def lead(**kw) -> Lead:
    base = dict(handle="lake_texoma_ata", tab="Texas", rows="2", school="Lake Texoma ATA", city="Pottsboro",
                first="Kathy", kind="", rating=4.9, reviews=134, locations=1, priority=1)
    base.update(kw)
    return Lead(**base)


# ── leads ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("url,handle", [
    ("https://www.instagram.com/legendmartialartsata/", "legendmartialartsata"),
    ("https://instagram.com/Arnolds.MartialArts?igsh=x", "arnolds.martialarts"),
    ("https://www.instagram.com/explore/", None),
    ("https://www.instagram.com/reel/", None),
    ("https://www.instagram.com/wix", None),
    ("https://www.instagram.com/fox_martial-arts", None),
    ("https://www.facebook.com/x", None),
])
def test_handle_of(url, handle):
    assert handle_of(url) == handle


@pytest.mark.parametrize("text,first", [
    ("Kathy Snyder (owner)", "Kathy"), ("Michael Pana’s (founder)", "Michael"), ("JOHN SMITH (owner)", "John"),
    ("", ""), ("Elite Martial Arts (owner)", ""), ("10th degree black belt", ""), ("Andrea Andrea Tabei (owner)", "Andrea"),
])
def test_first_name(text, first):
    assert first_name(text) == first


def test_call_kind_and_city():
    assert call_kind("Voicemail, Leave us a message, from: 8776524532, time: 3:42pm") == "voicemail"
    assert call_kind("Rang out, from: 8776524532") == "rang_out"
    assert call_kind("Line is busy, from: 1") == "busy"
    assert call_kind("Not interested, from: 1") == "not_interested"
    assert call_kind("Has a receptionist, Nicole picked up") == "receptionist"
    assert call_kind("") == ""
    assert city_of("510 S Mirick Ave, Denison, TX 75020") == "Denison"
    assert city_of("somewhere") == ""


def test_brand_name_of_a_chain():
    assert brand_name(["Premier Martial Arts, Bandera Road", "Premier Martial Arts Mission", "Premier Martial Arts"]) \
        == "Premier Martial Arts"
    assert brand_name(["Victory Martial Arts - Bandera", "Victory Martial Arts - Stone Oak"]) == "Victory Martial Arts"
    assert brand_name(["TX Black Belt Academy Midlothian", "TXBBA - Cedar HIll", "TX Black Belt Academy Mansfield"]) \
        == "TX Black Belt Academy"
    assert brand_name(["Bayani Warrior Martial Arts", "Protector Martial Arts"]) == "Bayani Warrior Martial Arts"
    assert brand_name(["Seeds 13 Jiu-Jitsu Academy - Early, TX"]) == "Seeds 13 Jiu-Jitsu Academy"


def test_build_leads_dedupes_and_skips():
    values = [HEADER,
              row(),
              row(title="Legend MA", ig="https://www.instagram.com/legend/", status="Not interested, from: 877"),
              row(title="Closed Dojo", ig="https://www.instagram.com/closed/", business="TEMPORARILY_CLOSED"),
              row(title="Zen Yoga", ig="https://www.instagram.com/zen/", category="Yoga studio"),
              row(title="Iron Gym", ig="https://www.instagram.com/irongym/", category="Gym", relevance="uncertain"),
              row(title="Built with Wix", ig="https://www.instagram.com/wix"),
              row(title="Chain Karate North", ig="https://www.instagram.com/chain/", address="1 A St, Plano, TX 75001"),
              row(title="Chain Karate South", ig="https://www.instagram.com/chain/", address="2 B St, Frisco, TX 75002"),
              row(title="Called Dojo", ig="https://www.instagram.com/called/", status="Voicemail, from: 877")]
    leads = {x.handle: x for x in build_leads("Texas", values)}
    assert "wix" not in leads
    assert leads["lake_texoma_ata"].skip == "" and leads["lake_texoma_ata"].first == "Kathy"
    assert leads["legend"].skip == "said not interested on the phone"
    assert "temporarily closed" in leads["closed"].skip
    assert leads["zen"].skip.startswith("not a martial arts business")
    assert leads["irongym"].skip.startswith("not a martial arts business")
    chain = leads["chain"]
    assert chain.locations == 2 and chain.rows == "8,9" and chain.city == "" and chain.school == "Chain Karate"
    assert leads["called"].kind == "voicemail" and leads["called"].priority == 0


# ── the message ──────────────────────────────────────────────────────────────

KINDS = ["", "voicemail", "rang_out", "busy", "silent", "receptionist", "ai", "out_of_service", "hung_up"]


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("first", ["Kathy", ""])
@pytest.mark.parametrize("locations", [1, 3])
def test_every_message_follows_the_rules(kind, first, locations):
    for i in range(25):
        text = compose(lead(handle=f"school{i}", kind=kind, first=first, locations=locations,
                            rating=4.9 if i % 2 else 3.9, reviews=134 if i % 3 else 5))
        assert message_problems(text, allowed=("Lake Texoma ATA",)) == ""
        assert not re.search(r"https?:|www\.|\.com\b|\.online\b|@", text)
        assert "(667) 220-6726" in text
        assert len(ig_dm.EMOJI.findall(text)) <= 2
        assert "{" not in text and "  " not in text
        assert text.rstrip().splitlines()[-1] in ("Ammar", "Ammar, MatBoss")
        if first:
            assert first in text.splitlines()[0]


def test_messages_are_personal_and_stable():
    a = compose(lead(kind="voicemail"))
    assert a == compose(lead(kind="voicemail"))  # preview shows exactly what run sends
    assert "voicemail" in a.lower() and "Kathy" in a
    texts = {compose(lead(handle=f"h{i}", kind="voicemail")) for i in range(40)}
    assert len(texts) == 40
    oos = compose(lead(kind="out_of_service"))
    assert "out of service" in oos and "lucky to have you" not in oos


def test_school_name_with_a_link_is_never_used():
    text = compose(lead(school="Karate.com Academy", first=""))
    assert "Karate.com" not in text and message_problems(text) == ""


@pytest.mark.parametrize("bad", ["see www.x.com", "go to matboss.online", "http://a.b", "dm @matboss_online",
                                 "a well-known school"])
def test_message_problems_catch_links_and_hyphens(bad):
    text = "Hey there! " + bad + " " + "x" * 200
    assert message_problems(text) != ""


# ── Texas time ───────────────────────────────────────────────────────────────

def ts(*args) -> float:
    return datetime(*args, tzinfo=timezone.utc).timestamp()


def test_central_daylight_saving():
    assert central_offset(datetime(2026, 3, 8, 7, 59, tzinfo=timezone.utc)) == -6
    assert central_offset(datetime(2026, 3, 8, 8, 0, tzinfo=timezone.utc)) == -5
    assert central_offset(datetime(2026, 11, 1, 6, 59, tzinfo=timezone.utc)) == -5
    assert central_offset(datetime(2026, 11, 1, 7, 0, tzinfo=timezone.utc)) == -6
    assert ig_dm.central_day(ts(2026, 11, 23, 5, 59)) == "2026-11-22"  # 23:59 CST
    assert ig_dm.central_day(ts(2026, 11, 23, 6, 0)) == "2026-11-23"


def test_window():
    assert seconds_until_window(ts(2026, 11, 23, 15, 0)) == 0  # 09:00 CST
    assert seconds_until_window(ts(2026, 11, 23, 14, 0)) == 3600  # 08:00 CST
    assert seconds_until_window(ts(2026, 11, 24, 3, 0)) == 12 * 3600  # 21:00 CST -> 09:00
    assert ig_dm.seconds_until_next_day(ts(2026, 11, 23, 20, 0)) == 19 * 3600  # 14:00 -> 09:00 next day
    # A one-off run with --end-hour 24 sends until midnight.
    assert seconds_until_window(ts(2026, 11, 28, 5, 30), (0, 24)) == 0.0  # 23:30 CST
    assert ig_dm.seconds_left_in_window(ts(2026, 11, 28, 5, 30), (0, 24)) == 30 * 60
    assert ig_dm.seconds_left_in_window(ts(2026, 11, 24, 0, 0), ig_dm.WINDOW) == 3 * 3600  # 18:00 -> 21:00


# ── screens ──────────────────────────────────────────────────────────────────

def n(label="", rid="", y=100, clickable=False, cls="android.widget.TextView", x=360, w=300, h=40, desc=False) -> Node:
    full = f"{INSTAGRAM}:id/{rid}" if rid else ""
    box = (x - w // 2, y - h // 2, x + w // 2, y + h // 2)
    return Node("" if desc else label, label if desc else "", full, INSTAGRAM, clickable, (x, y), box, False, cls)


def floor() -> Node:
    return n("", "", y=1540, w=720, h=40)  # gives the screen its 1560 px height


def profile_screen(handle="lake_texoma_ata", name="Lake Texoma ATA", message=True) -> list[Node]:
    nodes = [n("Back", y=107, x=40, w=80, clickable=True, desc=True), n(handle, "action_bar_title", y=107),
             n(name, "profile_header_full_name_above_vanity", y=199),
             n("Follow", "profile_header_follow_button", y=580, x=120, w=190, clickable=True)]
    if message:
        nodes += [n("Message", "button_container", y=580, x=326, w=190, clickable=True, desc=True),
                  n("Message", "", y=580, x=326, w=80)]
    return nodes + [n("Message", "direct_tab", y=1500, x=400, w=100, clickable=True, desc=True), floor()]


def thread_screen(name="Lake Texoma ATA", text="", bubbles=(), extra=()) -> list[Node]:
    nodes = [n("Back", y=100, x=40, w=80, clickable=True, desc=True), n(name, "header_title", y=100),
             *(n(b, "direct_text_message_text_view", y=900 + i * 60) for i, b in enumerate(bubbles)),
             *extra,
             n(text or "Message...", "row_thread_composer_edittext", y=1460, w=500, clickable=True,
               cls="android.widget.EditText")]
    if text:
        nodes.append(n("Send", "row_thread_composer_send_button_container", y=1460, x=660, w=80, clickable=True,
                       desc=True))
    return nodes + [floor()]


def test_message_button_is_the_profiles_not_the_inbox():
    button = profile_message_button(profile_screen())
    assert button is not None and button.rid.endswith("/button_container")
    assert profile_message_button(profile_screen(message=False)) is None


def test_thread_reading():
    nodes = thread_screen()
    box = composer(nodes)
    assert box is not None and composer_text(box) == ""
    assert send_button(nodes) is None
    assert thread_is_with(nodes, "lake_texoma_ata", "Lake Texoma ATA")
    assert not thread_is_with(nodes, "someone_else", "Someone Else")
    assert not has_history(nodes, box)
    assert has_history(thread_screen(bubbles=("hi there",)), None)
    typed = thread_screen(text="Hey Kathy!\n\nHi")
    assert composer_text(composer(typed)) == "Hey Kathy!\n\nHi" and send_button(typed) is not None
    long = "Hey Kathy 👋\n\nI called Lake Texoma ATA a little while back and met your voicemail."
    after = thread_screen(bubbles=(long.replace("\n", " ").replace(" 👋", ""),))
    assert message_shown(after, long, composer(after))
    assert not message_shown(thread_screen(), long, None)


def test_pushback_and_refusals():
    assert pushback_on(thread_screen(extra=(n("Try Again Later", y=700),)))
    assert pushback_on(thread_screen(extra=(n("We restrict certain activity to protect our community", y=700),)))
    assert not pushback_on(thread_screen())
    assert recipient_refuses(thread_screen(extra=(n("You can't message this account", y=700),)))


def test_account_title_skips_toolbar_buttons():
    nodes = [n("Create", "action_bar_button_action", y=100, x=600, clickable=True, desc=True),
             n("matboss_online", "action_bar_large_title_auto_size", y=100, x=200),
             n("Edit profile", "button", y=600, clickable=True), floor()]
    assert account_title(nodes).label == "matboss_online"
    assert account_title([n("Menu", "action_bar_title_menu", y=100, clickable=True), floor()]) is None


def own_profile_2026_11(username="matboss_online") -> list[Node]:
    """Instagram's own profile since 2026-11-26 (from a saved screen): no title in the top bar."""
    return [n("Create New", "profile_header_create_button", y=107, x=42, w=84, clickable=True, desc=True),
            n("Options", "", y=107, x=678, w=84, clickable=True, desc=True),
            n("Your profile. No story", "row_profile_header_imageview", y=270, x=108, w=147, desc=True),
            n("Ammar Alkh…", "profile_header_prominent_name", y=173, x=318, w=217, h=34, clickable=True,
              cls="android.widget.Button"),
            n(username, "profile_header_full_name_above_vanity", y=239, x=284, w=148, h=24),
            n("he/him/his/they", "profile_header_pronouns_above_vanity", y=239, x=440, w=150, h=24),
            n("935posts", "profile_header_post_count_front_familiar", y=292, x=277, w=135, clickable=True),
            n("Edit profile", "button", y=600, clickable=True), floor()]


def test_reads_the_username_from_the_newer_own_profile():
    nodes = own_profile_2026_11()
    assert account_title(nodes) is None  # nothing in the top bar any more
    name, switcher = ig_dm.header_account(nodes)
    assert name.label == "matboss_online"
    assert switcher.rid.endswith("/profile_header_prominent_name")  # the account switcher
    # The display name, pronouns or post count are never read as the username.
    name, _ = ig_dm.header_account([x for x in nodes if "above_vanity" not in x.rid])
    assert name is None
    assert ig_dm.header_account([x for x in nodes if "prominent_name" not in x.rid]) == (None, None)


# ── the flow, on a simulated phone ───────────────────────────────────────────

class FakeUi:
    def __init__(self, phone: "FakePhone") -> None:
        self.phone = phone

    def __call__(self, **selector):
        return self

    def set_text(self, text: str) -> None:
        self.phone.typed = self.phone.mangle(text)

    def get_text(self) -> str:
        if self.phone.get_text_fails:
            raise RuntimeError("UiObjectNotFoundException")
        return self.phone.typed or "Message..."


class FakePhone:
    """Just enough of Galaxy for Sender: an app with accounts, profiles and threads."""

    def __init__(self, tmp: Path, active="matboss_online", accounts=("matboss_online", "finder_acct"),
                 history=(), after_send=None, mangle=lambda t: t, pings=(True,), missing=(),
                 pause_while_waiting=0.0, dump_dots=True, get_text_fails=False) -> None:
        # dump_dots: the real dump writes each emoji as ".." (each UTF-16 unit a ".")
        self.dump_dots, self.get_text_fails = dump_dots, get_text_fails
        self.active, self.accounts, self.history = active, accounts, history
        self.after_send, self.mangle = after_send, mangle
        self.pings, self.missing = list(pings), set(missing)  # the last ping result repeats
        self.pause_while_waiting = pause_while_waiting
        self.phone_pause = 0.0
        self.state, self.handle, self.typed, self.sent = "home", "", "", []
        self.lock_path = tmp / "galaxy.lock"
        self._ui = FakeUi(self)
        self.paused: list[str] = []
        self.taps: list[str] = []

    # Galaxy's surface
    async def available(self): return True
    async def _hold_phone(self, wait_s=150, queue=False):
        self.lock_path.write_text("1")
        self.phone_pause = self.pause_while_waiting  # another process met a challenge meanwhile
        return True

    def _release_phone(self): self.lock_path.unlink(missing_ok=True)
    def phone_paused_for(self): return self.phone_pause
    def paused_for(self, app): return 0.0
    def _pause(self, app, why): self.paused.append(why)
    async def _stopped(self, app): return None
    async def _launcher_component(self): return f"{INSTAGRAM}/.Main"
    async def _leave(self, mode="home"): self.state = "home"
    async def _key(self, name): self.state = "own" if self.state == "switcher" else "home"

    async def _shell(self, cmd, timeout=25):
        if cmd.startswith("ping"):
            up = self.pings.pop(0) if len(self.pings) > 1 else self.pings[0]
            return f"2 packets transmitted, {2 if up else 0} received, {0 if up else 100}% packet loss"
        if "--activity-clear-top" in cmd:
            self.state = "main"
        return ""

    async def _input(self, cmd):
        m = re.search(r"instagram\.com/([^/]+)/", cmd)
        if m:
            self.state, self.handle, self.typed = "profile", m[1], ""
        return ""

    async def _until_profile_shown(self, handle):
        return await self._screen()

    async def _tap(self, node: Node):
        rid = node.rid.split("/")[-1]
        self.taps.append(rid or node.label)
        if rid == "profile_tab":
            self.state = "own"
        elif self.state == "own" and rid.startswith("action_bar"):
            self.state = "switcher"
        elif self.state == "switcher" and node.label in self.accounts:
            self.active, self.state = node.label, "main"
        elif self.state == "profile" and node.label == "Message":
            self.state = "thread"
        elif self.state == "thread" and node.label == "Send":
            self.sent.append((self.active, self.handle, self.typed))
            self.history = (*self.history, self.typed.replace("\n", " "))
            self.typed = ""
            self.state = "after"

    async def _screen(self):
        if self.state == "main":
            return [n("Profile", "profile_tab", y=1500, x=650, w=100, clickable=True, desc=True), floor()]
        if self.state in ("own", "switcher"):
            nodes = [n(self.active, "action_bar_title", y=100, x=200, clickable=True),
                     n("Edit profile", "button", y=600, clickable=True), floor()]
            if self.state == "switcher":
                nodes += [n(a, "row_user_primary_name", y=1200 + i * 80, clickable=True)
                          for i, a in enumerate(self.accounts)]
                nodes.append(n("Add Instagram account", "", y=1450, clickable=True))
            return nodes
        if self.state == "profile":
            if self.handle in self.missing:
                return [n("Sorry, this page isn't available.", y=400), floor()]
            return profile_screen(self.handle, "Lake Texoma ATA")
        if self.state in ("thread", "after"):
            extra = (n(self.after_send, y=700),) if self.state == "after" and self.after_send else ()
            show = ig_dm.as_dumped if self.dump_dots else (lambda t: t)
            return thread_screen("Lake Texoma ATA", show(self.typed), tuple(show(b) for b in self.history), extra)
        return [floor()]


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(ig_dm, "SCREENS_DIR", tmp_path / "screens")

    async def no_wait(self, seconds):
        return None

    monkeypatch.setattr(Sender, "wait", no_wait)
    s = Store(tmp_path / "dm.sqlite")
    s.upsert([lead(), lead(handle="second_school", school="Second School", first="")])
    return s


def run_batch(phone, store, leads=None):
    sender = Sender(phone, store)
    return asyncio.run(sender.batch(leads or store.next(1), gap=(0, 0)))


def test_sends_from_matboss_and_records_it(tmp_path, store):
    phone = FakePhone(tmp_path)
    sent, failures = run_batch(phone, store)
    assert (sent, failures) == (1, 0)
    account, handle, text = phone.sent[0]
    assert account == "matboss_online" and handle == "lake_texoma_ata" and text == compose(lead())
    row = store.db.execute("select * from leads where handle='lake_texoma_ata'").fetchone()
    assert row["state"] == "sent" and row["account"] == "matboss_online" and row["message"] == text
    assert store.sent_on(ig_dm.central_day()) == 1
    assert not phone.lock_path.exists()


def test_emoji_the_dump_shows_as_dots_still_send(tmp_path, store):
    emoji_lead = next(l for l in store.next(5) if any(ord(c) > 0xFFFF for c in compose(l)))
    for fails in (False, True):  # read directly, or (when that fails) through the dump
        s = Store(tmp_path / f"dm-{fails}.sqlite")
        s.upsert([emoji_lead])
        phone = FakePhone(tmp_path, get_text_fails=fails)
        sent, failures = run_batch(phone, s)
        assert (sent, failures) == (1, 0), fails
        assert phone.sent[0][2] == compose(emoji_lead)  # typed with its emoji
        assert s.db.execute("select state from leads").fetchone()[0] == "sent"


def test_as_dumped_matches_the_phone():
    assert ig_dm.as_dumped("on the phone \U0001F604\n\nok \U0001F94B.") == "on the phone ..\n\nok ..."


def test_switches_to_matboss_and_back(tmp_path, store):
    phone = FakePhone(tmp_path, active="finder_acct")
    sent, _ = run_batch(phone, store)
    assert sent == 1 and phone.sent[0][0] == "matboss_online"
    assert phone.active == "finder_acct"  # left as it was found


def test_never_sends_from_another_account(tmp_path, store):
    phone = FakePhone(tmp_path, active="finder_acct", accounts=("finder_acct",))
    with pytest.raises(AccountProblem):
        run_batch(phone, store)
    assert phone.sent == [] and "Add Instagram account" not in phone.taps


def test_text_that_did_not_type_exactly_is_not_sent(tmp_path, store):
    phone = FakePhone(tmp_path, mangle=lambda t: t[:50])
    sent, failures = run_batch(phone, store)
    assert (sent, failures) == (0, 1) and phone.sent == []
    row = store.db.execute("select state, attempts from leads where handle='lake_texoma_ata'").fetchone()
    assert row["state"] == "queued" and row["attempts"] == 1


def test_an_earlier_conversation_holds_the_lead(tmp_path, store):
    phone = FakePhone(tmp_path, history=("Hi! Do you have kids classes?",))
    sent, _ = run_batch(phone, store)
    assert sent == 0 and phone.sent == []
    assert store.db.execute("select state from leads where handle='lake_texoma_ata'").fetchone()[0] == "held"
    assert store.requeue() == 1


def test_try_again_later_after_send_stops_everything(tmp_path, store):
    phone = FakePhone(tmp_path, after_send="Try Again Later")
    with pytest.raises(Pushback):
        run_batch(phone, store, store.next(2))
    assert len(phone.sent) == 1  # the second school is never reached
    row = store.db.execute("select state from leads where handle='lake_texoma_ata'").fetchone()
    assert row["state"] == "unverified"  # it may have gone out: never again
    assert store.dm_pause_left() > 23 * 3600 and phone.paused
    assert store.next(5)[0].handle == "second_school"


def test_a_missing_account_is_skipped_when_online(tmp_path, store):
    phone = FakePhone(tmp_path, missing={"lake_texoma_ata"})
    sent, _ = run_batch(phone, store)
    row = store.db.execute("select state, why from leads where handle='lake_texoma_ata'").fetchone()
    assert sent == 0 and row["state"] == "skipped" and "does not exist" in row["why"]


def test_nothing_is_judged_while_the_phone_is_offline(tmp_path, store):
    # Online at the start, then the hotspot drops: Instagram's offline page reads
    # like a deleted account, so the lead must stay queued, untouched.
    phone = FakePhone(tmp_path, missing={"lake_texoma_ata"}, pings=(True, False))
    with pytest.raises(Offline):
        run_batch(phone, store)
    row = store.db.execute("select state, why, attempts from leads where handle='lake_texoma_ata'").fetchone()
    assert (row["state"], row["why"], row["attempts"]) == ("queued", "", 0)
    assert phone.sent == [] and not phone.lock_path.exists()


def test_a_pause_set_while_waiting_for_the_phone_stops_the_batch(tmp_path, store):
    phone = FakePhone(tmp_path, pause_while_waiting=12 * 3600)
    with pytest.raises(Paused):
        run_batch(phone, store, store.next(2))
    assert phone.taps == [] and phone.sent == [] and not phone.lock_path.exists()
    assert {r[0] for r in store.db.execute("select state from leads")} == {"queued"}


def test_an_offline_phone_starts_no_batch(tmp_path, store):
    phone = FakePhone(tmp_path, pings=(False,))
    with pytest.raises(Offline):
        run_batch(phone, store)
    assert phone.taps == [] and phone.sent == [] and not phone.lock_path.exists()
    assert store.next(5)[0].handle == "lake_texoma_ata"


def test_a_crash_mid_send_is_never_retried(tmp_path):
    s = Store(tmp_path / "dm.sqlite")
    s.upsert([lead()])
    s.mark("lake_texoma_ata", "sending", "")
    s.recover()
    assert s.next(5) == [] and s.counts() == {"unverified": 1}


def test_sync_keeps_phone_results(tmp_path):
    s = Store(tmp_path / "dm.sqlite")
    s.upsert([lead(), lead(handle="b")])
    s.mark("lake_texoma_ata", "sent", "")
    s.mark("b", "skipped", "phone: Instagram says the account does not exist")
    s.upsert([lead(skip="said not interested on the phone"), lead(handle="b")])
    assert s.counts() == {"sent": 1, "skipped": 1}
    s.upsert([lead(handle="c", skip="said not interested on the phone")])
    s.upsert([lead(handle="c")])  # the sheet changed its mind
    assert s.db.execute("select state from leads where handle='c'").fetchone()[0] == "queued"
