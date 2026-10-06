"""The ambient Reels session: the random maths, and what it is allowed to touch.

No phone and no network: screens are replayed from uiautomator-style dumps, and
`asyncio.sleep` is neutered the way test_galaxy_and_panel.py does it.
"""

import asyncio
import random
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import email_finder.android as android
from email_finder.ambient import AmbientSettings, ReelSession, hour_bucket, in_quiet_hours
from email_finder.android import Galaxy, PhoneUnavailable, parse_dump
from email_finder.cache import Cache

IG = "com.instagram.android"
REELS = "com.instagram.android/.activity.MainTabActivity"


def node(text="", desc="", rid="", clickable=False, bounds=(0, 0, 720, 1560), package=IG, selected=False):
    left, top, right, bottom = bounds
    return (f'<node index="0" text="{text}" resource-id="{rid}" class="android.widget.FrameLayout" '
            f'package="{package}" content-desc="{desc}" clickable="{str(clickable).lower()}" selected="{str(selected).lower()}" '
            f'bounds="[{left},{top}][{right},{bottom}]" />')


def screen(*nodes) -> str:
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>'
            f'<hierarchy rotation="0">{"".join(nodes)}</hierarchy>')


# The rail Instagram draws down the right of a Reel.
LIKE = node(desc="Like", rid=f"{IG}:id/like_button", clickable=True, bounds=(600, 900, 690, 990))
UNLIKE = node(desc="Unlike", rid=f"{IG}:id/like_button", clickable=True, bounds=(600, 900, 690, 990))
OVERFLOW = node(desc="More options", rid=f"{IG}:id/more_options", clickable=True, bounds=(600, 1020, 690, 1110))
AUTHOR = node(text="thegrindbjj", rid=f"{IG}:id/clips_username", clickable=True, bounds=(40, 120, 300, 180))
AVATAR = node(text="", desc="thegrindbjj", rid=f"{IG}:id/avatar", clickable=True, bounds=(40, 1000, 130, 1090))
REEL = screen(LIKE, OVERFLOW, AUTHOR, AVATAR)
LIKED_REEL = screen(UNLIKE, OVERFLOW, AUTHOR)
INTEREST_CONFIRMED = screen(LIKE, OVERFLOW, AUTHOR, node(text="Thanks for your feedback"))

FOLLOW_BUTTON = node(text="Follow", rid=f"{IG}:id/profile_action_button", clickable=True,
                     bounds=(40, 600, 400, 680))
FOLLOWING_BUTTON = node(text="Following", rid=f"{IG}:id/profile_action_button", clickable=True,
                        bounds=(40, 600, 400, 680))
PROFILE = screen(FOLLOW_BUTTON, node(text="The Grind BJJ", bounds=(40, 200, 400, 260)))
MENU_SAFE = screen(node(text="Interested", clickable=True, bounds=(40, 900, 680, 980)),
                   node(text="Not interested", clickable=True, bounds=(40, 990, 680, 1070)),
                   node(text="Save", clickable=True, bounds=(40, 1080, 680, 1160)))
MENU_DANGEROUS = screen(node(text="Report", clickable=True, bounds=(40, 900, 680, 980)),
                        node(text="Unfollow", clickable=True, bounds=(40, 990, 680, 1070)),
                        node(text="Why you're seeing this", clickable=True, bounds=(40, 1080, 680, 1160)))
# Every point a double tap would use is covered by a poll: not a like.
COVERED = screen(LIKE, OVERFLOW,
                 node(text="Vote", clickable=True, bounds=(200, 640, 520, 760)),
                 node(text="Vote", clickable=True, bounds=(200, 800, 520, 920)),
                 node(text="Vote", clickable=True, bounds=(150, 730, 400, 830)))
# The middle of the screen, for the "no button is in the way" check.
EMPTY_POINTS = {(360, 702), (360, 858), (252, 780)}


class FakePhone(Galaxy):
    """Galaxy with adb replaced by a script of screens."""

    def __init__(self, tmp_path, screens, foreground=REELS, **ambient):
        super().__init__(Cache(tmp_path / "c.db"), "adb", lock_path=tmp_path / "galaxy.lock",
                         ambient=AmbientSettings(quiet_hours=None, **ambient))
        self.screens, self.foreground, self.commands = list(screens), foreground, []
        self.unreadable = False

    async def available(self):
        return True

    async def _run(self, *args, timeout=25, tries=3):
        return ""

    async def _shell(self, command, timeout=25):
        self.commands.append(command)
        return "Physical size: 720x1560" if command == "wm size" else ""

    async def _input(self, command, timeout=15):
        # Never retried in the real class, and recorded once here too.
        self.commands.append(command)
        return ""

    async def _screen(self):
        if self.unreadable:
            raise PhoneUnavailable("the screen could not be read")
        if len(self.screens) > 1:  # the last screen stays up, as a real one would
            return parse_dump(self.screens.pop(0))
        return parse_dump(self.screens[0]) if self.screens else []

    async def _foreground(self):
        return self.foreground

    def taps(self) -> list[str]:
        return [c for c in self.commands if c.startswith("input tap")]

    def swipes(self) -> list[str]:
        return [c for c in self.commands if c.startswith("input swipe")]


def _quick(monkeypatch):
    async def no_wait(_):
        return None
    monkeypatch.setattr(android.asyncio, "sleep", no_wait)
    monkeypatch.setattr(android, "GAP", (0, 0))


def _settings(**kwargs) -> AmbientSettings:
    return AmbientSettings(quiet_hours=None, **kwargs)


def _session(**kwargs) -> ReelSession:
    return ReelSession(_settings(**kwargs), rng=random.Random(7))


def _centres(xml: str) -> set[tuple[int, int]]:
    return {n.center for n in parse_dump(xml)}


# ── the random maths ─────────────────────────────────────────────────────────


def test_gestures_stay_on_screen_and_use_a_mixture_of_speeds():
    session = _session()
    kinds, spans, durations = set(), [], []
    for _ in range(400):
        g = session.scroll(720, 1560)
        kinds.add(g.kind)
        spans.append(abs(g.y2 - g.y1))
        durations.append(g.duration)
        assert 0 <= g.x1 <= 720 and 0 <= g.x2 <= 720
        assert 187 <= g.y2 <= 1466  # below the status bar, above the nav bar
        assert 43 <= g.x2 <= 576  # clear of the right-hand action rail
    assert kinds == {"flick", "drag", "nudge"}
    assert min(spans) < 250 < 600 < max(spans)  # not one uniform distance
    assert min(durations) < 200 and max(durations) > 500  # nor one uniform speed


def test_scrolling_always_advances_instead_of_pulling_to_refresh():
    session = _session()
    drawn = [session.scroll(720, 1560) for _ in range(300)]
    angles = {g.x2 - g.x1 for g in drawn}
    assert all(g.y2 < g.y1 for g in drawn)
    assert len(angles) > 50  # a thumb, not a metronome


def test_watch_time_is_right_skewed_with_a_long_tail():
    session = _session()
    drawn = sorted(session.dwell() for _ in range(2000))
    assert 2.0 < drawn[len(drawn) // 2] < 5.0  # most reels get a few seconds
    assert max(drawn) > 15.0  # a few are watched properly
    assert min(drawn) >= 0.8 and max(drawn) <= 45.0


def test_engagement_is_rare_and_follows_are_rarest():
    session = _session()
    counts = {name: 0 for name in ("like", "follow", "interest", "pause", "none")}
    for _ in range(6000):
        counts[session.action()] += 1
    acting = 6000 - counts["none"]
    assert 0.05 < acting / 6000 < 0.35  # engaging, but most reels are just watched
    assert counts["follow"] < counts["like"]
    assert counts["follow"] < counts["interest"]


def test_a_session_gets_tired_and_then_ends():
    fresh = ReelSession(_settings(), rng=random.Random(11))
    worn = ReelSession(_settings(), rng=random.Random(11))
    worn.reels = 60
    likes = sum(fresh.action() == "like" for _ in range(4000))
    later = sum(worn.action() == "like" for _ in range(4000))
    assert later < likes  # attention and engagement tail off
    assert 4 <= fresh.limit <= 60
    fresh.reels = fresh.limit
    assert fresh.finished


def test_an_action_starts_its_own_cooldown():
    now = [1000.0]
    session = ReelSession(_settings(), rng=random.Random(3), clock=lambda: now[0])
    session.record("like")
    assert not any(session.action() == "like" for _ in range(50))
    now[0] += 3600  # the cooldown has long passed
    assert any(session.action() == "like" for _ in range(300))


def test_hour_buckets_and_quiet_hours():
    def at(hour):
        return time.mktime((2026, 10, 4, hour, 0, 0, 0, 0, -1))
    assert hour_bucket("ambient-like", 0) != hour_bucket("ambient-like", 3600)
    assert in_quiet_hours((2, 7), at(3)) is True
    assert in_quiet_hours((2, 7), at(12)) is False
    assert in_quiet_hours((22, 6), at(23)) is True  # wraps midnight
    assert in_quiet_hours((22, 6), at(5)) is True
    assert in_quiet_hours((22, 6), at(12)) is False
    assert in_quiet_hours(None, at(3)) is False


# ── what the phone is allowed to do ──────────────────────────────────────────


def test_a_like_taps_the_explicit_button_and_verifies_unlike(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [LIKED_REEL])
    button = android.find_button(parse_dump(REEL), "Like")
    assert asyncio.run(phone._like(parse_dump(REEL), _session())) is True
    taps = phone.taps()
    assert taps == [f"input tap {button.center[0]} {button.center[1]}"]


def test_a_like_falls_back_to_the_button_when_the_picture_is_covered(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [LIKED_REEL])
    covered = parse_dump(COVERED)
    assert android.safe_centre(covered, 720, 1560) is None
    assert asyncio.run(phone._like(covered, _session())) is True
    button = android.find_button(covered, "Like")
    assert phone.taps() == [f"input tap {button.center[0]} {button.center[1]}"]


def test_an_already_liked_reel_is_left_alone(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [LIKED_REEL])
    assert asyncio.run(phone._like(parse_dump(LIKED_REEL), _session())) is False
    assert phone.taps() == []


def test_the_interest_menu_is_tapped_only_for_an_exact_label(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [MENU_SAFE, INTEREST_CONFIRMED])
    assert asyncio.run(phone._interest(parse_dump(REEL), _session())) is True
    items = _centres(MENU_SAFE)
    chosen = [c for c in phone.taps() if tuple(int(v) for v in c.split()[2:4]) in items]
    assert len(chosen) == 1  # exactly one menu item, and it is the interest label
    assert "input keyevent KEYCODE_BACK" not in phone.commands


def test_a_menu_without_the_label_is_only_backed_out_of(tmp_path, monkeypatch):
    """The same menu holds Report and Unfollow: nothing else may ever be tapped."""
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [MENU_DANGEROUS])
    assert asyncio.run(phone._interest(parse_dump(REEL), _session())) is False
    forbidden = {f"input tap {x} {y}" for x, y in _centres(MENU_DANGEROUS)}
    assert not any(t in forbidden for t in phone.taps())
    assert "input keyevent KEYCODE_BACK" in phone.commands


def test_follow_uses_only_inline_button_and_confirms_result(tmp_path, monkeypatch):
    _quick(monkeypatch)
    inline = node(text="Follow", rid=f"{IG}:id/inline_follow_button", clickable=True,
                  bounds=(250, 1150, 390, 1240))
    confirmed = node(text="Following", rid=f"{IG}:id/inline_follow_button", clickable=True,
                     bounds=(250, 1150, 390, 1240))
    reel = screen(LIKE, OVERFLOW, AUTHOR, inline)
    phone = FakePhone(tmp_path, [screen(LIKE, AUTHOR, confirmed)])
    assert asyncio.run(phone._follow(parse_dump(reel))) is True
    assert phone.taps() == ["input tap 320 1195"]
    assert phone.followed_handles() == ["thegrindbjj"]
    phone.commands.clear()
    assert asyncio.run(phone._follow(parse_dump(reel))) is False  # already followed
    assert phone.taps() == []


def test_a_reel_without_a_readable_handle_is_not_followed(tmp_path, monkeypatch):
    _quick(monkeypatch)
    anonymous = screen(LIKE, OVERFLOW,
                       node(text="The Grind BJJ", clickable=True, bounds=(40, 120, 300, 180)))
    phone = FakePhone(tmp_path, [anonymous])
    assert android.author_handle(parse_dump(anonymous), 720, 1560) is None  # a name, not a handle
    assert asyncio.run(phone._follow(parse_dump(anonymous))) is False
    assert phone.taps() == []


def test_an_already_followed_profile_is_not_tapped(tmp_path, monkeypatch):
    _quick(monkeypatch)
    already = screen(FOLLOWING_BUTTON)
    phone = FakePhone(tmp_path, [already])
    assert asyncio.run(phone._follow(parse_dump(REEL))) is False
    forbidden = {f"input tap {x} {y}" for x, y in _centres(already)}
    assert not any(t in forbidden for t in phone.taps())
    assert phone.commands == []


def test_the_caps_bound_the_day_whatever_the_draw_says(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [REEL, LIKED_REEL], likes_per_hour=1)
    session = _session()
    assert asyncio.run(phone._act("like", session)) is True
    phone.commands.clear()
    assert asyncio.run(phone._act("like", session)) is False  # the cap refuses the second
    assert phone.taps() == []


def test_a_challenge_stops_the_session_and_the_phone(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [REEL],
                      foreground=f"{IG}/com.instagram.challenge.activity.ChallengeActivity")
    assert asyncio.run(phone._watch_one(_session())) is False
    assert phone.taps() == []  # nothing was touched on the challenge screen
    assert phone.paused_for("instagram") > 11 * 3600
    assert phone.phone_paused_for() > 11 * 3600


def test_a_login_screen_pauses_only_that_app(tmp_path, monkeypatch):
    """The app not being signed in is the user's job, not an account incident:
    it must not take the whole phone away for 12 hours."""
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [REEL], foreground=f"{IG}/com.instagram.activity.LoginActivity")
    assert asyncio.run(phone._watch_one(_session())) is False
    assert phone.taps() == []
    assert phone.paused_for("instagram") > 11 * 3600
    assert phone.phone_paused_for() == 0
    assert phone.paused_for("facebook") == 0  # the other app is still usable


def test_an_unreadable_reel_is_never_guessed_at(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [REEL])
    phone.unreadable = True
    assert asyncio.run(phone._ambient_slice(_session())) == 0
    assert phone.taps() == [] and phone.swipes() == []
    assert "could not be read" in phone._ambient_note


def test_queued_lookups_allow_one_reel_then_get_the_phone_back(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [REEL] * 40)
    phone._wanted = 1
    assert asyncio.run(phone._ambient_slice(_session())) == 1
    assert phone.swipes()
    assert not phone._ambient_has_turn
    phone._wanted = 0
    assert asyncio.run(phone._ambient_slice(_session())) > 0


def test_a_lookup_hands_the_phone_back_to_the_reels(tmp_path, monkeypatch):
    _quick(monkeypatch)
    contact = screen(FOLLOW_BUTTON, node(text="Contact", clickable=True, bounds=(40, 700, 400, 780)))
    phone = FakePhone(tmp_path, [contact, contact])
    asyncio.run(phone.instagram("thegrindbjj", return_to="reels"))
    assert phone.commands[-1] == "input keyevent KEYCODE_BACK"  # the session carries on
    phone.commands.clear()
    phone.screens = [contact, contact]
    asyncio.run(phone.instagram("thegrindbjj"))  # no ambient session: as it always was
    assert phone.commands[-1] == "input keyevent KEYCODE_HOME"


def test_an_unreadable_screen_is_reported_and_never_guessed_at(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [REEL])
    phone.unreadable = True
    found = asyncio.run(phone.instagram("thegrindbjj"))
    assert found.blocked == "the phone stopped answering" and not found.emails
    assert not any(c.startswith("input tap") for c in phone.commands)


def test_the_session_never_types_and_only_touches_known_labels(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [REEL])
    session = _session()  # every action enabled: the strictest case
    assert asyncio.run(phone._ambient_slice(session)) > 0
    assert not any("input text" in c or "KEYCODE_ENTER" in c for c in phone.commands)
    allowed = _centres(REEL) | EMPTY_POINTS
    for command in phone.taps():
        x, y = (int(v) for v in command.split()[2:4])
        assert (x, y) in allowed, command
    assert phone.swipes()  # it did scroll
    author = android.author_handle(parse_dump(REEL), 720, 1560)[1]
    if f"input tap {author.center[0]} {author.center[1]}" in phone.taps():
        assert phone.followed_handles()  # a follow always records the handle


def test_a_long_dwell_gives_way_to_a_queued_lookup(tmp_path, monkeypatch):
    """A lookup must not wait out a 45 s reel: the wait is interruptible."""
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [REEL] * 40)

    async def interrupt():
        phone._wanted = 1  # a lookup arrives mid-reel
        return await phone._wait(45.0)
    assert asyncio.run(interrupt()) is False
    assert phone.taps() == []


def test_feed_like_button_is_not_mistaken_for_a_reel():
    feed = screen(node(desc="Like", clickable=True, bounds=(0, 900, 90, 990)),
                  node(desc="Reels", clickable=True, bounds=(144, 1399, 288, 1480)),
                  node(bounds=(0, 0, 720, 1560)))
    assert not android.reel_on_screen(parse_dump(feed))
    assert android.reel_on_screen(parse_dump(REEL))


def test_open_reels_are_not_relaunched_or_refreshed(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [REEL])
    assert asyncio.run(phone._ensure_reels())
    assert phone.commands == []


def test_feed_opens_reels_tab_without_relaunching_instagram(tmp_path, monkeypatch):
    _quick(monkeypatch)
    feed = screen(node(desc="Reels", clickable=True, bounds=(144, 1399, 288, 1480)))
    phone = FakePhone(tmp_path, [feed, REEL])
    assert asyncio.run(phone._ensure_reels())
    assert phone.commands == ["input tap 216 1439"]


def test_failed_dump_does_not_read_a_stale_screen(tmp_path, monkeypatch):
    phone = Galaxy(Cache(tmp_path / "c.db"), "adb")
    monkeypatch.setattr(phone, "_read_live_xml", lambda: REEL)
    assert asyncio.run(phone._dump_xml()) == REEL

    def failed_read():
        raise OSError("device offline")

    monkeypatch.setattr(phone, "_read_live_xml", failed_read)
    with pytest.raises(PhoneUnavailable, match="live screen could not be read"):
        asyncio.run(phone._dump_xml())


def test_timeout_after_adb_exit_is_recoverable(tmp_path, monkeypatch):
    class ExitedProcess:
        reaped = False

        async def communicate(self):
            raise asyncio.TimeoutError

        def kill(self):
            raise ProcessLookupError

        async def wait(self):
            self.reaped = True

    process = ExitedProcess()

    async def spawn(*args, **kwargs):
        return process

    monkeypatch.setattr(android.asyncio, "create_subprocess_exec", spawn)
    phone = Galaxy(Cache(tmp_path / "c.db"), "adb")
    with pytest.raises(PhoneUnavailable, match="timed out"):
        asyncio.run(phone._run("shell", "uiautomator dump"))
    assert process.reaped


def test_ig449_selected_like_is_verified_and_never_unliked(tmp_path, monkeypatch):
    _quick(monkeypatch)
    liked = screen(node(desc="Like", rid=f"{IG}:id/like_button", clickable=True,
                        selected=True, bounds=(629, 644, 706, 721)))
    phone = FakePhone(tmp_path, [liked])
    assert asyncio.run(phone._like(parse_dump(REEL), _session()))
    assert len(phone.taps()) == 1
    phone.commands.clear()
    assert not asyncio.run(phone._like(parse_dump(liked), _session()))
    assert phone.taps() == []


def test_ig449_more_menu_and_real_interest_confirmation(tmp_path, monkeypatch):
    _quick(monkeypatch)
    reel = screen(LIKE, node(desc="More", rid=f"{IG}:id/clips_ufi_more_button_component",
                             clickable=True, bounds=(629, 1209, 706, 1286)))
    after = screen(LIKE, node(text="We'll suggest more posts like this for 30 days.",
                              rid=f"{IG}:id/snackbar_message"))
    phone = FakePhone(tmp_path, [MENU_SAFE, after])
    assert asyncio.run(phone._interest(parse_dump(reel), _session(interest_positive_odds=1.0)))
    assert len(phone.taps()) == 2
    assert "input keyevent KEYCODE_BACK" not in phone.commands


def test_visible_interest_button_does_not_require_overflow(tmp_path, monkeypatch):
    _quick(monkeypatch)
    reel = screen(LIKE, node(text="Interested", clickable=True, bounds=(400, 1200, 600, 1300)))
    phone = FakePhone(tmp_path, [INTEREST_CONFIRMED])
    assert asyncio.run(phone._interest(parse_dump(reel), _session(interest_positive_odds=1.0)))
    assert phone.taps() == ["input tap 500 1250"]


def test_unconfirmed_interest_is_not_counted_as_success(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [MENU_SAFE, REEL])
    assert not asyncio.run(phone._interest(parse_dump(REEL), _session()))
    assert "input keyevent KEYCODE_BACK" not in phone.commands


def test_menu_overlay_is_not_treated_as_the_reel_behind_it():
    assert not android.reel_on_screen(parse_dump(screen(LIKE, node(rid=f"{IG}:id/background_dimmer"))))


def test_unreadable_slices_do_not_consume_the_session_budget(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [REEL], slices_per_day=1)
    phone.unreadable = True
    assert asyncio.run(phone._ambient_slice(_session())) == 0
    assert phone.cache.count("ambient-slice") == 0
    phone.unreadable = False
    assert asyncio.run(phone._ambient_slice(_session())) > 0
    assert phone.cache.count("ambient-slice") == 1


def test_ambient_queues_between_lookups_without_overlap(tmp_path):
    phone = FakePhone(tmp_path, [REEL])
    order = []

    async def ambient_turn(session):
        assert phone._lock.locked()
        order.append("reels")
        return 1

    phone._ambient_slice_locked = ambient_turn

    async def lookup():
        async with phone._lock:
            order.append("lookup")

    async def run():
        await phone._lock.acquire()
        first = asyncio.create_task(lookup())
        await asyncio.sleep(0)
        reels = asyncio.create_task(phone._ambient_slice(_session()))
        await asyncio.sleep(0)
        second = asyncio.create_task(lookup())
        await asyncio.sleep(0)
        phone._lock.release()
        await asyncio.gather(first, reels, second)

    asyncio.run(run())
    assert order == ["lookup", "reels", "lookup"]


def test_finished_session_starts_another_without_leaving_instagram(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [REEL])
    old = phone._session = _session()
    old.reels = old.limit
    seen = []

    async def once(session):
        seen.append(session)
        phone._stop_ambient.set()
        return 1

    phone._ambient_slice = once
    asyncio.run(phone._ambient_loop())
    assert seen and seen[0] is not old
    assert "input keyevent KEYCODE_HOME" not in phone.commands
    assert phone._session_break() <= 5


def test_loop_recovers_after_an_unexpected_failure(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [REEL])
    attempts = []

    async def fail_once(session):
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("temporary read failure")
        phone._stop_ambient.set()
        return 1

    phone._ambient_slice = fail_once
    asyncio.run(phone._ambient_loop())
    assert len(attempts) == 2


@pytest.mark.parametrize("label", ["Sponsored", "Gesponsert", "Mehr dazu", "Jetzt bewerben"])
def test_ads_receive_no_engagement_clicks_or_budget_charges(tmp_path, monkeypatch, label):
    _quick(monkeypatch)
    ad = screen(LIKE, OVERFLOW, AUTHOR, node(text=label))
    phone = FakePhone(tmp_path, [ad])
    for action in ("like", "follow", "interest", "pause"):
        assert not asyncio.run(phone._act(action, _session()))
    assert phone.taps() == []
    assert phone.cache.count("ambient-follow") == 0


def test_follow_label_on_an_ad_cta_is_not_a_follow_control(tmp_path, monkeypatch):
    _quick(monkeypatch)
    ad = screen(LIKE, AUTHOR, node(text="Follow", rid=f"{IG}:id/ad_cta_button", clickable=True))
    phone = FakePhone(tmp_path, [ad])
    assert not asyncio.run(phone._follow(parse_dump(ad)))
    assert phone.taps() == []


def test_arbitrary_handle_shaped_ad_text_is_not_an_author():
    ad = screen(node(text="systemgas4382", rid=f"{IG}:id/static_header_business_name", clickable=True))
    assert android.author_handle(parse_dump(ad), 720, 1560) is None


def test_a_reel_without_explicit_pause_control_gets_no_picture_taps(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [REEL])
    assert not asyncio.run(phone._pause_reel(parse_dump(REEL)))
    assert phone.taps() == []


def test_lead_form_is_cleared_without_tapping_its_fields(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [REEL], foreground=f"{IG}/com.instagram.leadads.activity.LeadAdsActivity")
    original_shell = phone._shell

    async def shell(command, timeout=25):
        if "--activity-clear-top" in command:
            phone.foreground = REELS
        return await original_shell(command, timeout)

    phone._shell = shell
    assert asyncio.run(phone._ensure_reels())
    assert any("--activity-clear-top" in c for c in phone.commands)
    assert phone.taps() == [] and phone.swipes() == []


def test_stale_reel_tree_cannot_drive_a_lead_form(tmp_path, monkeypatch):
    _quick(monkeypatch)
    phone = FakePhone(tmp_path, [REEL], foreground=f"{IG}/com.instagram.leadads.activity.LeadAdsActivity")
    assert not asyncio.run(phone._act("follow", _session()))
    assert phone.taps() == []
