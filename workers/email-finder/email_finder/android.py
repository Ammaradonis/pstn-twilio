"""The user's Samsung Galaxy A20e over USB debugging (adb): the real Instagram
and Facebook apps, as the backup to the browser's iPhone emulation, not a
replacement for it. It is used when Meta resists the browser (a login wall,
checkpoint or CAPTCHA, a paused platform, the day's page limit) or the browser
found no address. Unlike Instagram's website, the Instagram app shows a
business's Contact button.

Between lookups the phone would otherwise sit outside Instagram, which is itself
a pattern worth avoiding, so the worker keeps an ordinary Reels session going:
it scrolls with the randomised gestures of ambient.py, watches for a drawn
time, and occasionally engages. Lookups and Reels take turns using the phone,
so neither can starve the other when research is busy.

House rules
* Only reads the screen (UiAutomator hierarchy) and taps the profile's own buttons.
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
  more read after 3 seconds without pulling down to refresh.
* One process at a time drives the phone (a lock file shared by the worker and
  any probe script), so nobody presses Home in the middle of someone else's wait.
* 10-20 s between profiles, EMAIL_FINDER_GALAXY_DAILY_LIMIT lookups a day.
"""

from __future__ import annotations

import asyncio
from contextlib import suppress
import logging
import os
import random
import re
import shutil
import subprocess
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
AD_ACTIVITY = re.compile(r"leadads|browserlite|inappbrowser", re.I)
AD_LABELS = {"sponsored", "gesponsert", "werbung", "anzeige", "ad", "learn more", "mehr dazu",
             "jetzt bewerben", "apply now", "sign up", "registrieren", "shop now", "jetzt kaufen"}
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
    selected: bool = False

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
                          n.get("package", ""), n.get("clickable") == "true", center, box,
                          n.get("selected") == "true"))
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
    return any(n.package == INSTAGRAM and NOT_FOUND.search(n.label) for n in nodes if n.label)


def instagram_profile_shown(nodes: list[Node], handle: str) -> bool:
    """Verify the requested profile, not the old profile or a Reel's Message tab."""
    visible = [n for n in nodes if n.package == INSTAGRAM
               and n.bounds[2] > n.bounds[0] and n.bounds[3] > n.bounds[1]]
    return (any(n.rid == f"{INSTAGRAM}:id/action_bar_title"
                and n.label.lstrip("@").casefold() == handle.casefold() for n in visible)
            and any(n.rid.startswith(f"{INSTAGRAM}:id/profile_header_") for n in visible))


def find_button(nodes: list[Node], *names: str) -> Node | None:
    wanted = {n.lower() for n in names}
    for n in nodes:
        if n.label.lower() in wanted and n.center != (0, 0):
            return n
    return None


def reel_on_screen(nodes: list[Node]) -> bool:
    """Require the Reel's right-hand rail; feed posts also have Like buttons."""
    instagram = [n for n in nodes if n.package == INSTAGRAM]
    if any(n.rid == f"{INSTAGRAM}:id/background_dimmer" for n in instagram):
        return False  # a menu/dialog can include the Reel behind it in the tree
    width = max((n.bounds[2] for n in instagram), default=0)
    return width > 0 and any(
        n.label in REEL_ANCHORS and n.clickable and n.center[0] >= width * 0.8
        for n in instagram
    )


def reel_is_liked(nodes: list[Node]) -> bool:
    button = find_button(nodes, "Like", "Unlike")
    return button is not None and (button.label == "Unlike" or button.selected)


def sponsored_reel(nodes: list[Node]) -> bool:
    return any(n.package == INSTAGRAM and (
        n.label.casefold() in AD_LABELS or any(part in n.rid.lower() for part in
        ("sponsored", "lead_gen", "leadgen", "lead_ads", "ad_cta", "ad_action", "cta_button",
         "static_header_business_name", "bb_primary_action_container"))) for n in nodes)


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


def author_handle(nodes: list[Node], width: int = 0, height: int = 0) -> tuple[str, Node] | None:
    """The Reel author's handle and the node to tap to open their profile.

    Only Instagram's explicit Reel-author resource IDs count. Generic title,
    name and handle-shaped ad text are never treated as author controls.
    """
    for n in nodes:
        if n.package != INSTAGRAM or n.rid not in (
            f"{INSTAGRAM}:id/clips_author_username", f"{INSTAGRAM}:id/clips_username"
        ) or not n.clickable or n.center == (0, 0):
            continue
        text = (n.text or "").strip().lstrip("@")
        if not HANDLE.match(text):
            continue
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
        self._ui = None  # persistent hierarchy reader; can read a playing video
        self._session: ReelSession | None = None
        self._ambient_task: asyncio.Task | None = None
        self._stop_ambient = asyncio.Event()
        self._wanted = 0  # lookups waiting for the phone right now
        self._ambient_note = ""  # why the last slice did nothing, for the log
        self._ambient_has_turn = False

    # ── adb plumbing ─────────────────────────────────────────────────────────

    async def _run(self, *args: str, timeout: float = 25, tries: int = 3) -> str:
        """One adb command. Read-only commands are retried: the phone drops off
        USB often enough (measured: 2 of 10 calls) that a single failure would
        otherwise be read as an empty screen. Input commands never come here."""
        text = ""
        for attempt in range(max(1, tries)):
            cmd = [self.adb] + (["-s", self.serial] if self.serial else []) + list(args)
            # pythonw hides the worker, but console children such as adb still
            # open a terminal unless each launch explicitly disables its console.
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            try:
                out, _ = await asyncio.wait_for(proc.communicate(), timeout)
            except (asyncio.TimeoutError, asyncio.CancelledError) as err:
                with suppress(ProcessLookupError):
                    proc.kill()
                await proc.wait()
                if isinstance(err, asyncio.TimeoutError):
                    raise PhoneUnavailable("the phone command timed out") from err
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

    def _read_live_xml(self) -> str:
        # The shell dumper waits for idle and fails on playing Reels. The
        # persistent reader returns the current tree without pausing the video.
        import uiautomator2 as u2

        if self._ui is None:
            self._ui = u2.connect(self.serial)
        self._ui.jsonrpc.setConfigurator(
            {"waitForIdleTimeout": 0, "waitForSelectorTimeout": 0}, http_timeout=12)
        return self._ui.jsonrpc.dumpWindowHierarchy(True, 50, http_timeout=12)

    async def _dump_xml(self) -> str:
        # Read directly: no on-device XML file that can outlive a failed dump.
        # Shield the read on cancellation and wait for it before releasing the
        # phone lock, so a background thread cannot overlap the next driver.
        task = asyncio.create_task(asyncio.to_thread(self._read_live_xml))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            with suppress(Exception):
                await task
            raise
        except Exception as err:
            self._ui = None
            raise PhoneUnavailable("the live screen could not be read") from err

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
        except (PhoneUnavailable, OSError, asyncio.TimeoutError):
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

    async def _until_profile_shown(self, handle: str) -> list[Node]:
        """Wait for this account's header; old screens are not lookup results."""
        nodes: list[Node] = []
        for _ in range(LOAD_S):
            nodes = await self._screen()
            if instagram_profile_shown(nodes, handle) or user_not_found(nodes):
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
        if not re.fullmatch(r"[A-Za-z0-9._]{1,30}", handle):
            return AppLookup(blocked="invalid Instagram handle")
        leave = return_to or ("reels" if self.ambient_running else "home")
        self._wanted += 1  # an ambient slice yields after at most one Reel
        try:
            async with self._lock:
                if not await self._hold_phone():
                    return AppLookup(blocked="busy (another process is using the phone)")
                try:
                    why = await self._turn("instagram")
                    if why:
                        return AppLookup(blocked=why)
                    try:
                        log.info("%s Instagram: opening @%s", DEVICE_NAME, handle)
                        found = await self._instagram(handle)
                        log.info("%s Instagram @%s: %s", DEVICE_NAME, handle,
                                 found.blocked or ("profile missing" if found.missing else
                                 f"profile verified; {len(found.emails)} address(es)"))
                        return found
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
        missing = False
        for visit in range(2):
            stop = await self._stopped("instagram")
            if stop:
                result.blocked = stop
                return result
            await self._input(f"am start -a android.intent.action.VIEW -d https://www.instagram.com/{handle}/ -p {INSTAGRAM}")
            nodes = await self._until_profile_shown(handle)
            stop = await self._stopped("instagram")
            if stop:
                result.blocked = stop
                return result
            missing = user_not_found(nodes)
            if not missing and instagram_profile_shown(nodes, handle):
                break
            log.info("Instagram @%s: %s (try %d of 2)", handle,
                     "user not found" if missing else "requested profile did not open", visit + 1)
            await asyncio.sleep(2)
        else:
            result.missing = missing
            result.blocked = None if missing else "requested Instagram profile did not open"
            return result
        contact = None
        for attempt in range(2):
            if attempt:
                await self._until_profile_shown(handle)  # allow delayed profile controls to load
            await asyncio.sleep(SETTLE_S)
            stop = await self._stopped("instagram")
            if stop:
                result.blocked = stop
                return result
            nodes = await self._screen()
            if not instagram_profile_shown(nodes, handle):
                return AppLookup(blocked="Instagram left the requested profile before contact lookup")
            nodes = [n for n in nodes if n.package == INSTAGRAM]
            result.context = " ".join(n.label for n in nodes if n.label)[:2000]
            for email in emails_on_screen(nodes):
                result.emails.setdefault(email, "page")
            contact = find_button(nodes, "Contact", "Email")
            if contact or attempt:
                break
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
        for attempt in range(4):
            sheet = await self._screen()
            if any(n.package in EMAIL_APPS or (n.package == INSTAGRAM and
                   ("contact_option" in n.rid or n.label.lower() in {"call", "send email", "directions"}))
                   for n in sheet):
                break
            if attempt < 3:
                await asyncio.sleep(0.5)
        else:
            raise PhoneUnavailable("Instagram Contact did not open its sheet or email app")
        if any(n.package in EMAIL_APPS for n in sheet):
            found = emails_on_screen([n for n in sheet if n.package in EMAIL_APPS])
            await self._discard_draft(sheet)
            return found, []
        sheet = [n for n in sheet if n.package == INSTAGRAM]
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
            elif step > 0:
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
        stop = await self._stopped("instagram")
        if stop:
            self._ambient_note = f"stopped on a {stop.rsplit('.', 1)[-1]} screen"
            return False
        activity = await self._foreground()
        if activity.startswith(INSTAGRAM + "/") and AD_ACTIVITY.search(activity):
            log.warning("%s ambient: leaving ad/lead form without interacting with it", DEVICE_NAME)
            await self._shell(f"am start --activity-clear-top -n {await self._launcher_component()}")
            await asyncio.sleep(2.0)
            if AD_ACTIVITY.search(await self._foreground()):
                self._ambient_note = "could not leave the ad screen; no controls touched"
                return False
        if not (await self._foreground()).startswith(INSTAGRAM + "/"):
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
            self._ambient_note = "no Reels tab on screen; " + self._describe_screen(nodes)
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
        dwell = session.dwell()
        if self._wanted and self._ambient_has_turn:
            dwell = min(dwell, 5.0)  # one bounded Reel between queued lookups
        if not await self._wait(dwell):
            return False  # a lookup wants the phone: stop before acting
        action = session.action()
        if action != "none" and await self._act(action, session):
            session.record(action)
        # Menus, ad forms and browser activities must never receive the next
        # swipe (or a tap interpreted from it) using the old Reel's coordinates.
        if AD_ACTIVITY.search(await self._foreground()) or not reel_on_screen(await self._screen()):
            self._ambient_note = "left Reels after an action; recovering before scrolling"
            return False
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
            if (self._wanted and not self._ambient_has_turn) or self._stop_ambient.is_set():
                return False
            await asyncio.sleep(min(step, left))
            left -= step
        return not ((self._wanted and not self._ambient_has_turn) or self._stop_ambient.is_set())

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
        if not getattr(self.ambient, action, False):
            return False
        if await self._stopped("instagram") or AD_ACTIVITY.search(await self._foreground()):
            return False
        nodes = await self._screen()
        if not reel_on_screen(nodes) or sponsored_reel(nodes):
            if sponsored_reel(nodes):
                log.info("%s ambient: sponsored Reel; skipping engagement", DEVICE_NAME)
            return False
        if action in self.CAPS:
            name, per_hour, per_day = self.CAPS[action]
            if not self.cache.reserve(hour_bucket(name), int(getattr(self.ambient, per_hour))):
                log.info("%s ambient: hourly %s cap reached; not acting", DEVICE_NAME, action)
                return False
            if not self.cache.reserve(name, int(getattr(self.ambient, per_day))):
                log.info("%s ambient: daily %s cap reached; not acting", DEVICE_NAME, action)
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
        """Tap Like once and verify the selected state (IG 449 keeps its label)."""
        if reel_is_liked(nodes):
            return False  # already liked
        button = find_button(nodes, "Like")
        if button is None:
            return False
        await self._tap(button)
        await asyncio.sleep(1.2)
        if not reel_is_liked(await self._screen()):
            log.info("%s ambient: the like did not register", DEVICE_NAME)
            return False
        log.info("%s ambient: liked Reel (selected Like control confirmed)", DEVICE_NAME)
        return True

    async def _follow(self, nodes: list[Node]) -> bool:
        """Follow only through the Reel's explicit inline Follow control."""
        if sponsored_reel(nodes) or not reel_on_screen(nodes):
            return False
        found = author_handle(nodes)
        if found is None:
            return False
        handle, _ = found
        if handle in self._followed():
            return False
        follow = next((n for n in nodes if n.package == INSTAGRAM
                       and n.rid == f"{INSTAGRAM}:id/inline_follow_button" and n.clickable
                       and n.label in ("Follow", "Folgen")), None)
        if follow is None:
            return False
        await self._tap(follow)
        await asyncio.sleep(1.5)
        if AD_ACTIVITY.search(await self._foreground()):
            log.warning("%s ambient: unexpected ad screen after Follow; stopping this action", DEVICE_NAME)
            return False
        after = await self._screen()
        if not any(n.rid == follow.rid and (n.selected or n.label in
                   ("Following", "Requested", "Abonniert", "Angefragt")) for n in after):
            log.info("%s ambient: Follow tapped for %s; result unconfirmed", DEVICE_NAME, handle)
            return False
        self._remember_follow(handle)
        log.info("%s ambient: followed %s", DEVICE_NAME, handle)
        return True

    async def _interest(self, nodes: list[Node], session: ReelSession) -> bool:
        """Overflow menu -> Interested / Not interested, and nothing else.

        That menu also holds Report, Hide and Unfollow, so only an exact label
        match is ever tapped; anything unexpected gets a Back."""
        want = MENU_INTEREST[0] if session.picks_interested() else MENU_INTEREST[1]
        target = find_button(nodes, want)
        if target is None:
            menu = find_button(nodes, "More options", "More")
            if menu is None:
                log.info("%s ambient: no Reel overflow control", DEVICE_NAME)
                return False
            await self._tap(menu)
            await asyncio.sleep(1.3)
            items = await self._screen()
            target = find_button(items, want)
        if target is None:
            await self._key("KEYCODE_BACK")
            log.info("%s ambient: %r is not offered for this Reel", DEVICE_NAME, want)
            return False
        await self._tap(target)
        await asyncio.sleep(0.3)
        # Instagram dismisses this sheet itself. An unconditional Back here
        # used to exit Reels, interrupting the very next scroll.
        confirmed = False
        for _ in range(3):
            after = await self._screen()
            confirmed = any(re.search(r"thanks for (?:your |the )?feedback|we.ll (?:show|suggest|recommend) (?:you )?(?:more|fewer)|"
                                      r"you.ll see (?:more|fewer)|(?:marked|mark) as (?:not )?interested",
                                      n.label, re.I) for n in after)
            if confirmed:
                break
            await asyncio.sleep(0.6)  # the acknowledgement may arrive after the sheet closes
        if confirmed:
            log.info("%s ambient: marked %r (feedback confirmed)", DEVICE_NAME, want)
        else:
            log.info("%s ambient: tapped %r; feedback not confirmed", DEVICE_NAME, want)
        if not reel_on_screen(after):
            await self._key("KEYCODE_BACK")
        return confirmed

    async def _pause_reel(self, nodes: list[Node]) -> bool:
        """Use a labelled video control only; video-centre taps can open ads."""
        if sponsored_reel(nodes):
            return False
        pause = find_button(nodes, "Pause video", "Video pausieren")
        if pause is None:
            return False
        await self._tap(pause)
        await self._wait(random.uniform(2.0, 6.0))
        play = find_button(await self._screen(), "Play video", "Video abspielen")
        if play is None:
            return False
        await self._tap(play)
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
        if self.cache.count("ambient-slice") >= self.ambient.slices_per_day:
            return "the daily session limit is reached"
        return None

    async def _ambient_slice(self, session: ReelSession) -> int:
        """Queue fairly with profile lookups instead of starving behind them."""
        async with self._lock:
            return await self._ambient_slice_locked(session)

    async def _ambient_slice_locked(self, session: ReelSession) -> int:
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
            if not self.cache.reserve("ambient-slice", self.ambient.slices_per_day):
                self._ambient_note = "the daily session limit is reached"
                return 0
            self._ambient_has_turn = True
            for _ in range(session.slice_length()):
                if (self._wanted and watched) or session.finished or self._stop_ambient.is_set():
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
            self._ambient_has_turn = False
            self._release_phone()
        return watched

    def _session_break(self) -> float:
        return random.uniform(2.0, 5.0)

    async def _ambient_loop(self) -> None:
        engaging = [n for n in ("like", "follow", "interest") if getattr(self.ambient, n)]
        log.info("%s ambient session: watching Reels between lookups (%s)", DEVICE_NAME,
                 "engaging with " + ", ".join(engaging) if engaging else "no engagement")
        said = ""
        while not self._stop_ambient.is_set():
            try:
                session = self._session
                if session is None:
                    session = self._session = ReelSession(self.ambient)
                    log.info("%s ambient: new session, %s", DEVICE_NAME, session.describe())
                if session.finished:
                    self._session = None
                    await asyncio.sleep(self._session_break())
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
            except Exception:  # noqa: BLE001 - a transient error must not kill the loop
                log.exception("%s ambient: error; retrying in 5 seconds", DEVICE_NAME)
                await asyncio.sleep(5.0)

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
