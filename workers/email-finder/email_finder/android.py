"""The user's Samsung Galaxy A20e over USB debugging (adb): the real Instagram
and Facebook apps, as the backup to the browser's iPhone emulation, not a
replacement for it. It is used when Meta resists the browser (a login wall,
checkpoint or CAPTCHA, a paused platform, the day's page limit) or the browser
found no address. Unlike Instagram's website, the Instagram app shows a
business's Contact button.

Between lookups the phone would otherwise sit outside Instagram, which is itself
a pattern worth avoiding, so the worker keeps an ordinary Reels session going:
it scrolls with the randomised gestures of ambient.py, watches for a drawn
time, and occasionally engages. A lookup preempts the session at the end of the
current gesture, opens the profile, reads it, and hands the phone back.

House rules
* Only reads the screen (uiautomator dump) and taps the profile's own buttons.
  Never types and never sends anything.
* Ambient activity is limited to what `ambient.AmbientSettings` allows and is
  capped per hour and per day. No comments, no messages, no shares, no saving,
  and it never unfollows. In any menu it taps only an exact label it knows
  (Interested / Not interested) and presses Back otherwise, so it can never land
  on Report, Hide or Unfollow by accident.
* Every action that changes something on the account is taken only after a
  freshly dumped, verified screen says the expected button is there. A screen
  that cannot be read is never guessed at.
* Never touches a security challenge or a login screen: it stops, pauses that
  app for 12 hours and logs it, and the user clears it on the phone. A challenge
  also silences the phone for the worker's lookups unless that is turned off.
* Input commands are never retried: a tap that may or may not have landed is
  reported as an unreadable phone rather than fired twice.
* Contact -> Email opens a draft in the phone's email app; the address is read
  from it and the draft is discarded.
* Instagram profiles get 3 seconds, once loaded, to show Contact, then one
  refresh and 3 more.
* One process at a time drives the phone (a lock file shared by the worker and
  any probe script), so nobody presses Home in the middle of someone else's wait.
* 10-20 s between profiles, EMAIL_FINDER_GALAXY_DAILY_LIMIT lookups a day.
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import re
import shutil
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path

from .ambient import (AmbientSettings, Gesture, ReelSession, ambient_settings, hour_bucket,
                      in_quiet_hours)
from .cache import Cache
from .config import CACHE_DIR

log = logging.getLogger(__name__)

DEVICE_NAME = "Galaxy A20e"
INSTAGRAM = "com.instagram.android"
FACEBOOK = "com.facebook.katana"
EMAIL_APPS = ("com.google.android.gm", "com.samsung.android.email.provider")
SETTLE_S = 3.0  # how long a loaded profile gets to show its Contact button
LOAD_S = 10  # how long the app gets to put the profile on screen at all
LOCK_STALE_S = 600  # a lock older than this was left by a process that died
PROFILE_SHOWN = ("Follow", "Following", "Message", "Edit profile", "Requested")
# Instagram's answer for a handle it can't show. Golden rule: open it twice
# before moving on (it is sometimes a passing hiccup).
NOT_FOUND = re.compile(r"user not found|page isn.t available|link you followed may be broken", re.I)
GAP = (10.0, 20.0)
STATE_NS = "social-state"
APP_PAUSE = 12 * 3600
# Screens that need the user, never the worker.
STOP_SCREEN = re.compile(r"challenge|checkpoint|login|signup|nux|twofac|captcha|confirm", re.I)
# Of those, the ones that mean the account itself was challenged. A plain login
# or signup screen only means the app is not signed in, which is the user's job
# to fix but is not an incident: it pauses that app, it does not stop the phone.
CHALLENGE_SCREEN = re.compile(r"challenge|checkpoint|twofac|captcha|confirm", re.I)
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
BOUNDS = re.compile(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")
PHONE = re.compile(r"^\+?[\d\s().-]{7,20}$")
# ambient: what a Reel shows, what the overflow menu may be tapped for, and how
# a profile's handle looks. The menu is the dangerous one -- it holds Report and
# Unfollow -- so only these two labels are ever tapped.
REEL_ANCHORS = ("Like", "Unlike", "Comment", "Share")
MENU_INTEREST = ("Interested", "Not interested")
HANDLE = re.compile(r"^[a-z0-9._]{3,30}$")
HANDLE_RIDS = ("username", "profile_name", "title", "name")
# A failed adb command reads like this; the device dropping off USB is common
# enough that every read-only command is retried, and no input command is.
TRANSPORT_ERRORS = ("device not found", "device offline", "no devices/emulators",
                    "device unauthorized", "error: closed", "cannot connect")
DUMP_TAIL = "</hierarchy>"


class PhoneUnavailable(RuntimeError):
    """The phone could not be read, or an input command may not have landed."""


@dataclass
class Node:
    text: str
    desc: str
    rid: str
    package: str
    clickable: bool
    center: tuple[int, int]
    bounds: tuple[int, int, int, int] = (0, 0, 0, 0)

    @property
    def label(self) -> str:
        return (self.text or self.desc).strip()

    def holds(self, x: int, y: int) -> bool:
        left, top, right, bottom = self.bounds
        return left <= x <= right and top <= y <= bottom


@dataclass
class AppLookup:
    """What the phone showed for one profile."""
    emails: dict[str, str] = field(default_factory=dict)  # address -> "contact" | "page"
    phones: list[str] = field(default_factory=list)  # from the Contact sheet
    context: str = ""
    blocked: str | None = None  # why the app wasn't usable
    missing: bool = False  # Instagram said "User not found" on both tries


def parse_dump(xml: str) -> list[Node]:
    start, end = xml.find("<?xml"), xml.rfind(DUMP_TAIL)
    if start < 0 or end < 0:
        return []
    root = ET.fromstring(xml[start:end + len(DUMP_TAIL)])
    nodes = []
    for n in root.iter("node"):
        m = BOUNDS.match(n.get("bounds", ""))
        box = (int(m[1]), int(m[2]), int(m[3]), int(m[4])) if m else (0, 0, 0, 0)
        center = ((box[0] + box[2]) // 2, (box[1] + box[3]) // 2) if m else (0, 0)
        nodes.append(Node(n.get("text", ""), n.get("content-desc", ""), n.get("resource-id", ""),
                          n.get("package", ""), n.get("clickable") == "true", center, box))
    return nodes


def emails_on_screen(nodes: list[Node]) -> list[str]:
    found: list[str] = []
    for n in nodes:
        for email in EMAIL.findall(f"{n.text} {n.desc}"):
            email = email.lower().rstrip(".")
            if email not in found:
                found.append(email)
    return found


def user_not_found(nodes: list[Node]) -> bool:
    return any(NOT_FOUND.search(n.label) for n in nodes if n.label)


def find_button(nodes: list[Node], *names: str) -> Node | None:
    wanted = {n.lower() for n in names}
    for n in nodes:
        if n.label.lower() in wanted and n.center != (0, 0):
            return n
    return None


def reel_on_screen(nodes: list[Node]) -> bool:
    """True when these nodes are a Reel: its like/comment/share rail is up."""
    return find_button(nodes, *REEL_ANCHORS) is not None


def node_at(nodes: list[Node], x: int, y: int) -> Node | None:
    """The clickable node covering a point, if any -- what a tap would hit."""
    for n in nodes:
        if n.clickable and n.center != (0, 0) and (n.bounds != (0, 0, 0, 0)) and n.holds(x, y):
            return n
    return None


def safe_centre(nodes: list[Node], width: int, height: int) -> tuple[int, int] | None:
    """A point in the middle of the Reel that no button covers, so a double tap
    lands on the video (a like) rather than on a sticker, poll or profile."""
    for x, y in ((width // 2, int(height * 0.45)), (width // 2, int(height * 0.55)),
                 (int(width * 0.35), int(height * 0.50))):
        if node_at(nodes, x, y) is None:
            return x, y
    return None


def author_handle(nodes: list[Node], width: int, height: int) -> tuple[str, Node] | None:
    """The Reel author's handle and the node to tap to open their profile.

    Only a clickable node in the top strip whose text is exactly a handle shape
    counts -- a display name ("The Grind BJJ") has spaces and never matches, so
    this cannot open a caption or a mention by mistake. Returns None rather than
    guessing, and the caller then skips the follow.
    """
    for n in nodes:
        if not n.clickable or n.center == (0, 0) or n.center[1] > height * 0.35:
            continue
        if n.center[0] > width * 0.75:
            continue
        text = (n.text or "").strip().lstrip("@")
        if not HANDLE.match(text):
            continue
        if any(word in n.rid.lower() for word in HANDLE_RIDS) or len(text) >= 5:
            return text, n
    return None


def find_adb() -> str | None:
    local = Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "platform-tools" / "adb.exe"
    sdk = Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk" / "platform-tools" / "adb.exe"
    for candidate in (os.environ.get("EMAIL_FINDER_ADB"), shutil.which("adb"), str(local), str(sdk)):
        if candidate and Path(candidate).is_file():
            return candidate
    return None


class Galaxy:
    def __init__(self, cache: Cache, adb: str, serial: str | None = None, daily_limit: int = 150,
                 lock_path: Path | None = None, ambient: AmbientSettings | None = None) -> None:
        self.cache, self.adb, self.serial, self.daily_limit = cache, adb, serial, daily_limit
        self.lock_path = lock_path or CACHE_DIR / "galaxy.lock"
        self.ambient = ambient if ambient is not None else ambient_settings()
        self._lock = asyncio.Lock()
        self._last = 0.0
        self._size: tuple[int, int] | None = None
        self._activity = ""  # the app's launcher component, resolved once
        self._session: ReelSession | None = None
        self._ambient_task: asyncio.Task | None = None
        self._stop_ambient = asyncio.Event()
        self._wanted = 0  # lookups waiting for the phone right now
        self._ambient_note = ""  # why the last slice did nothing, for the log

    # ── adb plumbing ─────────────────────────────────────────────────────────

    async def _run(self, *args: str, timeout: float = 25, tries: int = 3) -> str:
        """One adb command. Read-only commands are retried: the phone drops off
        USB often enough (measured: 2 of 10 calls) that a single failure would
        otherwise be read as an empty screen. Input commands never come here."""
        text = ""
        for attempt in range(max(1, tries)):
            cmd = [self.adb] + (["-s", self.serial] if self.serial else []) + list(args)
            proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE,
                                                        stderr=asyncio.subprocess.STDOUT)
            try:
                out, _ = await asyncio.wait_for(proc.communicate(), timeout)
            except asyncio.TimeoutError:
                proc.kill()
                raise
            text = out.decode("utf-8", errors="replace")
            if not any(err in text.lower() for err in TRANSPORT_ERRORS):
                return text
            if attempt + 1 < tries:
                log.info("%s dropped off USB (%s); retrying", DEVICE_NAME, text.strip()[:80])
                await asyncio.sleep(0.6 * (attempt + 1))
        return text

    async def _shell(self, command: str, timeout: float = 25) -> str:
        return await self._run("shell", command, timeout=timeout)

    async def _input(self, command: str, timeout: float = 15) -> str:
        """A command that changes the phone (tap, swipe, key). It is never
        retried: a tap that may have landed twice is worse than a missed one."""
        out = await self._run("shell", command, timeout=timeout, tries=1)
        if any(err in out.lower() for err in TRANSPORT_ERRORS):
            raise PhoneUnavailable(f"{DEVICE_NAME} did not accept: {command}")
        return out

    async def _dump_xml(self) -> str:
        await self._shell("uiautomator dump /sdcard/ef-ui.xml >/dev/null 2>&1")
        return await self._run("exec-out", "cat", "/sdcard/ef-ui.xml")

    async def _screen(self) -> list[Node]:
        """The screen's nodes. Raises rather than returning [] when the phone
        can't be read: an empty list would be taken for "no Contact button"."""
        for _ in range(2):
            text = await self._dump_xml()
            if DUMP_TAIL in text:
                try:
                    return parse_dump(text)
                except ET.ParseError:
                    log.info("%s returned a truncated screen dump", DEVICE_NAME)
            await asyncio.sleep(1)
        raise PhoneUnavailable("the screen could not be read")

    async def _foreground(self) -> str:
        out = await self._shell("dumpsys activity activities | grep -m1 mResumedActivity")
        m = re.search(r"u0 (\S+?)/(\S+?)[ }]", out)
        return f"{m[1]}/{m[2]}" if m else ""

    async def _geometry(self) -> tuple[int, int]:
        """The screen size in pixels, so gestures are not hard-coded to one
        phone (the A20e is 720x1560)."""
        if self._size is None:
            m = re.search(r"(\d+)x(\d+)", await self._shell("wm size"))
            self._size = (int(m[1]), int(m[2])) if m else (720, 1560)
        return self._size

    async def _tap(self, node: Node) -> None:
        await self._input(f"input tap {node.center[0]} {node.center[1]}")

    async def _tap_point(self, x: int, y: int) -> None:
        await self._input(f"input tap {x} {y}")

    async def _double_tap(self, x: int, y: int, gap: float) -> None:
        await self._input(f"input tap {x} {y}")
        await asyncio.sleep(gap)
        await self._input(f"input tap {x} {y}")

    async def _swipe(self, g: Gesture) -> None:
        await self._input(g.as_command())

    async def _key(self, name: str) -> None:
        await self._input(f"input keyevent {name}")

    async def _home(self) -> None:
        """Idempotent, so it may be retried when the link hiccups."""
        await self._shell("input keyevent KEYCODE_HOME")

    async def _refresh(self) -> None:
        width, height = await self._geometry()
        await self._input(f"input swipe {width // 2} {int(0.29 * height)} "
                          f"{width // 2} {int(0.80 * height)} 350")  # pull to refresh

    async def available(self) -> bool:
        try:
            if (await self._run("get-state", timeout=8)).strip() != "device":
                return False
            window = await self._shell("dumpsys window | grep -m1 isKeyguardShowing")
            if "isKeyguardShowing=true" in window:
                log.info("%s is locked; unlock it to let the worker use it", DEVICE_NAME)
                return False
            await self._shell("input keyevent KEYCODE_WAKEUP")
            return True
        except (OSError, asyncio.TimeoutError):
            return False

    # ── one driver at a time ─────────────────────────────────────────────────

    async def _hold_phone(self, wait_s: float = 150) -> bool:
        deadline = time.monotonic() + wait_s
        while True:
            try:
                fd = os.open(self.lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                return True
            except FileExistsError:
                try:
                    if time.time() - self.lock_path.stat().st_mtime > LOCK_STALE_S:
                        self.lock_path.unlink(missing_ok=True)
                        continue
                except FileNotFoundError:
                    continue
            if time.monotonic() > deadline:
                return False
            await asyncio.sleep(2)

    def _release_phone(self) -> None:
        """Remove the lock only while it is still ours: a hold that ran long
        enough to be taken over must not delete the new owner's lock."""
        try:
            if self.lock_path.read_text().strip() == str(os.getpid()):
                self.lock_path.unlink(missing_ok=True)
        except (FileNotFoundError, OSError):
            pass

    async def _until_profile_shown(self) -> list[Node]:
        """The screen once the app shows the profile (or after LOAD_S seconds)."""
        nodes: list[Node] = []
        for _ in range(LOAD_S):
            nodes = await self._screen()
            if any(n.label in PROFILE_SHOWN for n in nodes) or user_not_found(nodes):
                return nodes
            await asyncio.sleep(1)
        return nodes

    # ── pacing and pauses ────────────────────────────────────────────────────

    def paused_for(self, app: str) -> float:
        state = self.cache.get(STATE_NS, f"{app}-app-pause") or {}
        return max(0.0, float(state.get("until", 0)) - time.time())

    def phone_paused_for(self) -> float:
        """Seconds until the whole phone may be used again (a challenge stops
        lookups too, not just the app the challenge appeared in)."""
        state = self.cache.get(STATE_NS, "galaxy-pause") or {}
        return max(0.0, float(state.get("until", 0)) - time.time())

    def _pause(self, app: str, why: str) -> None:
        self.cache.set(STATE_NS, f"{app}-app-pause", {"until": time.time() + APP_PAUSE, "why": why}, 30 * 86400)
        log.warning("%s: the %s app shows %s. It needs you on the phone; the worker leaves it alone for "
                    "%d h.", DEVICE_NAME, app.title(), why, APP_PAUSE // 3600)

    def _stop_everything(self, why: str) -> None:
        """A challenge is the loudest "we noticed you" the account gets, so go
        quiet: no lookups and no ambient activity on the phone for a while."""
        hours = self.ambient.cap_hours
        self.cache.set(STATE_NS, "galaxy-pause", {"until": time.time() + hours * 3600, "why": why},
                       30 * 86400)
        log.warning("%s showed %s. The phone is left alone entirely for %d h; clear it on the phone.",
                    DEVICE_NAME, why, hours)

    async def _turn(self, app: str) -> str | None:
        """None when the phone may be used now (after the gap), else why not."""
        if self.phone_paused_for():
            return "the phone is paused after a security check"
        if self.paused_for(app):
            return "paused"
        if not await self.available():
            return "unavailable"
        if not self.cache.reserve("galaxy", self.daily_limit):
            return "daily limit"
        wait = self._last + random.uniform(*GAP) - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        self._last = time.monotonic()
        return None

    async def _stopped(self, app: str) -> str | None:
        """Why the app can't be used right now (a challenge/login screen), if so."""
        activity = await self._foreground()
        package, _, name = activity.partition("/")
        if package.startswith(("com.instagram", "com.facebook")) and STOP_SCREEN.search(name):
            self._pause(app, f"a {name.rsplit('.', 1)[-1]} screen")
            if CHALLENGE_SCREEN.search(name) and self.ambient.stop_lookups_on_challenge:
                # A challenge is about the account, so the phone stops entirely.
                # A login screen is not: the app just needs signing in again, and
                # the other app, and the phone, stay usable.
                self._stop_everything(f"a {name.rsplit('.', 1)[-1]} screen")
            return name
        return None

    # ── leaving the app ──────────────────────────────────────────────────────

    @property
    def ambient_running(self) -> bool:
        return self._ambient_task is not None and not self._ambient_task.done()

    async def _leave(self, mode: str) -> None:
        """`home` (the default, what a lookup always did) or `reels`, which hands
        the phone back to the running ambient session instead of putting the app
        away in the middle of what looks like one continuous session."""
        try:
            if mode == "reels":
                await self._key("KEYCODE_BACK")
            else:
                await self._home()
        except (PhoneUnavailable, OSError, asyncio.TimeoutError):
            log.info("%s: could not leave the app cleanly", DEVICE_NAME)

    # ── Instagram ────────────────────────────────────────────────────────────

    async def instagram(self, handle: str, return_to: str | None = None) -> AppLookup:
        leave = return_to or ("reels" if self.ambient_running else "home")
        self._wanted += 1  # an ambient slice yields the phone at its next gesture
        try:
            async with self._lock:
                if not await self._hold_phone():
                    return AppLookup(blocked="busy (another process is using the phone)")
                try:
                    why = await self._turn("instagram")
                    if why:
                        return AppLookup(blocked=why)
                    try:
                        return await self._instagram(handle)
                    except PhoneUnavailable as err:
                        log.info("%s: %s", DEVICE_NAME, err)
                        return AppLookup(blocked="the phone stopped answering")
                    finally:
                        await self._leave(leave)
                finally:
                    self._release_phone()
        finally:
            self._wanted -= 1

    async def _instagram(self, handle: str) -> AppLookup:
        result = AppLookup()
        for visit in range(2):
            await self._shell(f"am start -a android.intent.action.VIEW -d https://www.instagram.com/{handle}/ -p {INSTAGRAM}")
            if not user_not_found(await self._until_profile_shown()):
                break
            log.info("Instagram says %s isn't there (try %d of 2)", handle, visit + 1)
            await asyncio.sleep(2)
        else:
            result.missing = True
            return result
        contact = None
        for attempt in range(2):
            if attempt:
                await self._until_profile_shown()  # after the refresh
            await asyncio.sleep(SETTLE_S)
            stop = await self._stopped("instagram")
            if stop:
                result.blocked = stop
                return result
            nodes = await self._screen()
            result.context = " ".join(n.label for n in nodes if n.label)[:2000]
            for email in emails_on_screen(nodes):
                result.emails.setdefault(email, "page")
            contact = find_button(nodes, "Contact", "Email")
            if contact or attempt:
                break
            await self._refresh()
        if contact:
            emails, result.phones = await self._open_contact(contact)
            for email in emails:
                result.emails[email] = "contact"
        return result

    async def _open_contact(self, button: Node) -> tuple[list[str], list[str]]:
        """Contact (or Email) button -> the addresses (and phone numbers) it holds.
        The Instagram app lists them on its Contact sheet ("Call ...", "Email ...")."""
        await self._tap(button)
        await asyncio.sleep(1.5)
        sheet = await self._screen()
        found = emails_on_screen(sheet)
        phones = [n.label for n in sheet if n.rid.endswith("contact_option_sub_text") and PHONE.match(n.label)]
        if found:
            await self._shell("input keyevent KEYCODE_BACK")  # close the sheet
            return found, phones
        email_option = find_button(sheet, "Email", "Send email", "Email address")
        if email_option is None and button.label.lower() != "email":
            await self._shell("input keyevent KEYCODE_BACK")
            return [], phones
        if email_option is not None:
            await self._tap(email_option)
        await asyncio.sleep(2.5)
        draft = await self._screen()
        found = emails_on_screen([n for n in draft if n.package in EMAIL_APPS])
        await self._discard_draft(draft)
        return found, phones

    async def _discard_draft(self, nodes: list[Node]) -> None:
        """Leave the email app without sending: overflow menu -> Discard, then close it."""
        if not any(n.package in EMAIL_APPS for n in nodes):
            await self._shell("input keyevent KEYCODE_BACK")
            return
        menu = find_button(nodes, "More options")
        if menu:
            await self._tap(menu)
            await asyncio.sleep(1)
            discard = find_button(await self._screen(), "Discard")
            if discard:
                await self._tap(discard)
                await asyncio.sleep(1)
                confirm = find_button(await self._screen(), "Discard")
                if confirm:
                    await self._tap(confirm)
        for package in EMAIL_APPS:
            await self._shell(f"am force-stop {package}")

    # ── Facebook ─────────────────────────────────────────────────────────────

    async def facebook(self, url: str, return_to: str | None = None) -> AppLookup:
        leave = return_to or ("reels" if self.ambient_running else "home")
        self._wanted += 1
        try:
            async with self._lock:
                if not await self._hold_phone():
                    return AppLookup(blocked="busy (another process is using the phone)")
                try:
                    why = await self._turn("facebook")
                    if why:
                        return AppLookup(blocked=why)
                    try:
                        return await self._facebook(url)
                    except PhoneUnavailable as err:
                        log.info("%s: %s", DEVICE_NAME, err)
                        return AppLookup(blocked="the phone stopped answering")
                    finally:
                        await self._leave(leave)
                finally:
                    self._release_phone()
        finally:
            self._wanted -= 1

    async def _facebook(self, url: str) -> AppLookup:
        result = AppLookup()
        await self._shell(f"am start -a android.intent.action.VIEW -d '{url}' -p {FACEBOOK}")
        for step in range(3):
            await asyncio.sleep(SETTLE_S)
            stop = await self._stopped("facebook")
            if stop:
                result.blocked = stop
                return result
            nodes = await self._screen()
            result.context = (result.context + " " + " ".join(n.label for n in nodes if n.label))[:4000]
            for email in emails_on_screen(nodes):
                result.emails.setdefault(email, "page")
            if result.emails:
                break
            about = find_button(nodes, "About", "See About info", "Contact info") if step == 0 else None
            if about:
                await self._tap(about)
            elif step == 0:
                await self._refresh()
            else:
                break
        return result

    # ── the ambient Reels session ────────────────────────────────────────────
    #
    # Between lookups the phone watches Reels, so the account looks like what it
    # is logged in as rather than like something that only ever opens profiles.
    # A lookup preempts the session at the next gesture.

    AMBIENT_NS = "ambient-state"
    # action -> (counter name, per-hour setting, per-day setting)
    CAPS = {"like": ("ambient-like", "likes_per_hour", "likes_per_day"),
            "interest": ("ambient-interest", "interests_per_hour", "interests_per_day"),
            "follow": ("ambient-follow", "follows_per_hour", "follows_per_day")}

    def _followed(self) -> set[str]:
        return set(self.cache.get(self.AMBIENT_NS, "followed") or [])

    def _remember_follow(self, handle: str) -> None:
        self.cache.set(self.AMBIENT_NS, "followed", sorted(self._followed() | {handle})[-500:],
                       180 * 86400)

    def followed_handles(self) -> list[str]:
        """Handles the ambient session has followed, for the user to review."""
        return sorted(self._followed())

    async def _launcher_component(self) -> str:
        """The component a launcher tap would start, resolved once."""
        if not self._activity:
            out = await self._shell(f"cmd package resolve-activity --brief {INSTAGRAM}")
            line = out.strip().splitlines()[-1].strip() if out.strip() else ""
            self._activity = line if "/" in line and " " not in line \
                else f"{INSTAGRAM}/.activity.MainTabActivity"
        return self._activity

    async def _resync(self) -> bool:
        """One Back, then check: an action may have left a dialog or a profile
        up. True when a Reel is showing again."""
        await self._key("KEYCODE_BACK")
        await asyncio.sleep(1.5)
        return reel_on_screen(await self._screen())

    async def _ensure_reels(self) -> bool:
        """Get to a Reel, tapping only verified labels; False says why not."""
        if reel_on_screen(await self._screen()):
            return True
        stop = await self._stopped("instagram")
        if stop:
            self._ambient_note = f"stopped on a {stop.rsplit('.', 1)[-1]} screen"
            return False
        await self._shell(f"am start -n {await self._launcher_component()}")
        await asyncio.sleep(4.0)
        stop = await self._stopped("instagram")
        if stop:
            self._ambient_note = f"stopped on a {stop.rsplit('.', 1)[-1]} screen"
            return False
        nodes = await self._screen()
        if reel_on_screen(nodes):
            return True
        tab = find_button(nodes, "Reels", "Clips")
        if tab is None:
            self._ambient_note = "no Reels tab on screen"
            return False
        await self._tap(tab)
        await asyncio.sleep(3.5)
        if reel_on_screen(await self._screen()):
            return True
        self._ambient_note = "Reels did not open"
        return False

    async def _watch_one(self, session: ReelSession) -> bool:
        """One Reel: verify the screen, watch it, maybe act, page on."""
        nodes = await self._screen()
        if not reel_on_screen(nodes):
            if not await self._resync():
                self._ambient_note = self._describe_screen(nodes)
                return False
            nodes = await self._screen()
        stop = await self._stopped("instagram")
        if stop:
            self._ambient_note = f"stopped on a {stop.rsplit('.', 1)[-1]} screen"
            return False
        if not await self._wait(session.dwell()):
            return False  # a lookup wants the phone: stop before acting
        action = session.action()
        if action != "none" and await self._act(action, session):
            session.record(action)
        session.watched()
        width, height = await self._geometry()
        await self._swipe(session.scroll(width, height))
        await self._wait(random.uniform(0.4, 1.2))
        if session.paging_fast():  # two reels in a row, the way a thumb does it
            await self._swipe(session.scroll(width, height))
            await self._wait(random.uniform(0.3, 0.9))
        log.info("%s ambient: %s", DEVICE_NAME, session.describe())
        return True

    async def _wait(self, seconds: float, step: float = 0.5) -> bool:
        """Wait, but come back at once when a lookup wants the phone.

        Sleeping the whole dwell in one go would hold a queued lookup for up to
        45 s, which is longer than the gap a lookup would have waited anyway.
        False means the wait was cut short and nothing should be done.
        """
        left = seconds
        while left > 0:
            if self._wanted or self._stop_ambient.is_set():
                return False
            await asyncio.sleep(min(step, left))
            left -= step
        return not (self._wanted or self._stop_ambient.is_set())

    def _describe_screen(self, nodes: list[Node]) -> str:
        """What was on screen, for when the Reels labels don't match: without
        this the session just quietly does nothing."""
        seen = [n.label for n in nodes if n.label][:4]
        return "not a Reels screen (saw: " + (", ".join(seen) if seen else "nothing") + ")"

    async def _act(self, action: str, session: ReelSession) -> bool:
        """Do one engagement action. False when a cap or the screen says no.

        The caps are checked first and consume their slot, so a day's worth of
        likes, follows and interest marks is bounded no matter what the random
        draw asks for.
        """
        if action in self.CAPS:
            name, per_hour, per_day = self.CAPS[action]
            if not self.cache.reserve(hour_bucket(name), int(getattr(self.ambient, per_hour))):
                log.info("%s ambient: hourly %s cap reached; not acting", DEVICE_NAME, action)
                return False
            if not self.cache.reserve(name, int(getattr(self.ambient, per_day))):
                log.info("%s ambient: daily %s cap reached; not acting", DEVICE_NAME, action)
                return False
        nodes = await self._screen()  # a fresh screen, never a remembered one
        if not reel_on_screen(nodes):
            return False
        if action == "like":
            return await self._like(nodes, session)
        if action == "follow":
            return await self._follow(nodes)
        if action == "interest":
            return await self._interest(nodes, session)
        if action == "pause":
            return await self._pause_reel(nodes)
        return False

    async def _like(self, nodes: list[Node], session: ReelSession) -> bool:
        """A double tap on the picture, as a person likes a Reel -- taken on a
        point no button covers, so it cannot land on a poll, sticker or avatar."""
        if find_button(nodes, "Unlike") is not None:
            return False  # already liked
        width, height = await self._geometry()
        point = safe_centre(nodes, width, height)
        if point is not None:
            await self._double_tap(point[0], point[1], session.double_tap_gap())
        else:
            button = find_button(nodes, "Like")
            if button is None:
                return False
            await self._tap(button)
        await asyncio.sleep(1.2)
        if find_button(await self._screen(), "Unlike") is None:
            log.info("%s ambient: the like did not register", DEVICE_NAME)
            return False
        return True

    async def _follow(self, nodes: list[Node]) -> bool:
        """Open the author's profile and follow it. Skips rather than guesses
        when the handle cannot be identified with certainty."""
        width, height = await self._geometry()
        found = author_handle(nodes, width, height)
        if found is None:
            return False
        handle, node = found
        if handle in self._followed():
            return False
        await self._tap(node)
        await asyncio.sleep(2.5)
        follow = find_button(await self._screen(), "Follow")
        if follow is None:
            await self._key("KEYCODE_BACK")  # already following, or not a profile
            return False
        await self._tap(follow)
        await asyncio.sleep(1.5)
        await self._key("KEYCODE_BACK")
        await asyncio.sleep(1.0)
        self._remember_follow(handle)
        log.info("%s ambient: followed %s", DEVICE_NAME, handle)
        return True

    async def _interest(self, nodes: list[Node], session: ReelSession) -> bool:
        """Overflow menu -> Interested / Not interested, and nothing else.

        That menu also holds Report, Hide and Unfollow, so only an exact label
        match is ever tapped; anything unexpected gets a Back."""
        menu = find_button(nodes, "More options")
        if menu is None:
            return False
        await self._tap(menu)
        await asyncio.sleep(1.3)
        items = await self._screen()
        want = MENU_INTEREST[0] if session.picks_interested() else MENU_INTEREST[1]
        target = find_button(items, want)
        if target is None:
            await self._key("KEYCODE_BACK")
            return False
        await self._tap(target)
        await asyncio.sleep(1.4)
        await self._key("KEYCODE_BACK")
        log.info("%s ambient: marked %r", DEVICE_NAME, want)
        return True

    async def _pause_reel(self, nodes: list[Node]) -> bool:
        """Tap to pause the Reel, then tap to carry on: the least risky thing
        the session can do, and it still reads as attention."""
        width, height = await self._geometry()
        point = safe_centre(nodes, width, height)
        if point is None:
            return False
        await self._tap_point(*point)
        await self._wait(random.uniform(2.0, 6.0))
        await self._tap_point(*point)
        return True

    # ── driving the session ──────────────────────────────────────────────────

    async def _ambient_turn(self) -> str | None:
        """None when ambient activity may run now, else why not."""
        if not self.ambient.enabled:
            return "turned off"
        if self.phone_paused_for():
            return "the phone is paused after a security check"
        if self.paused_for("instagram"):
            return "the Instagram app is paused"
        if in_quiet_hours(self.ambient.quiet_hours):
            return "quiet hours"
        if not await self.available():
            return "the phone is unavailable"
        if not self.cache.reserve("ambient-slice", self.ambient.slices_per_day):
            return "the daily session limit is reached"
        return None

    async def _ambient_slice(self, session: ReelSession) -> int:
        """One short burst on the phone, so a lookup waits only a few seconds."""
        if self._wanted:
            return 0
        if not await self._hold_phone(wait_s=5):
            return 0
        watched = 0
        try:
            why = await self._ambient_turn()
            if why:
                self._ambient_note = why
                return 0
            if not await self._ensure_reels():
                return 0
            for _ in range(session.slice_length()):
                if self._wanted or self._stop_ambient.is_set():
                    break
                if not self.cache.reserve("ambient-gesture", self.ambient.gestures_per_day):
                    self._ambient_note = "the daily gesture limit is reached"
                    break
                if not await self._watch_one(session):
                    break
                watched += 1
        except PhoneUnavailable as err:
            self._ambient_note = str(err)
        finally:
            self._release_phone()
        return watched

    def _session_break(self) -> float:
        return random.uniform(300.0, 1200.0)

    async def _ambient_loop(self) -> None:
        engaging = [n for n in ("like", "follow", "interest") if getattr(self.ambient, n)]
        log.info("%s ambient session: watching Reels between lookups (%s)", DEVICE_NAME,
                 "engaging with " + ", ".join(engaging) if engaging else "no engagement")
        said = ""
        try:
            while not self._stop_ambient.is_set():
                session = self._session
                if session is None:
                    session = self._session = ReelSession(self.ambient)
                    log.info("%s ambient: new session, %s", DEVICE_NAME, session.describe())
                if session.finished:
                    self._session = None
                    await self._home()
                    await asyncio.sleep(self._session_break())
                    continue
                if self._wanted:
                    await asyncio.sleep(0.5)
                    continue
                if await self._ambient_slice(session) == 0:
                    if self._ambient_note and self._ambient_note != said:
                        said = self._ambient_note
                        log.info("%s ambient: %s", DEVICE_NAME, said)
                    await asyncio.sleep(30.0)
                    continue
                said = ""
                await asyncio.sleep(session.rest())
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a session must never take the worker down
            log.exception("%s ambient session stopped after an error", DEVICE_NAME)

    def start_ambient(self) -> bool:
        """Watch Reels between lookups. False when it is off or already running."""
        if not self.ambient.enabled:
            log.info("Ambient Instagram sessions are off (EMAIL_FINDER_AMBIENT=off)")
            return False
        if self.ambient_running:
            return False
        self._stop_ambient.clear()
        self._ambient_task = asyncio.create_task(self._ambient_loop())
        return True

    async def stop_ambient(self) -> None:
        self._stop_ambient.set()
        task, self._ambient_task = self._ambient_task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:  # noqa: BLE001
                log.exception("%s ambient session ended badly", DEVICE_NAME)
