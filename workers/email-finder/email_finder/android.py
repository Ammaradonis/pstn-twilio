"""The user's Samsung Galaxy A20e over USB debugging (adb): the real Instagram
and Facebook apps, as the backup to the browser's iPhone emulation, not a
replacement for it. It is used when Meta resists the browser (a login wall,
checkpoint or CAPTCHA, a paused platform, the day's page limit) or the browser
found no address. Unlike Instagram's website, the Instagram app shows a
business's Contact button.

House rules
* Only reads the screen (uiautomator dump) and taps a profile's own buttons.
  Never types and never sends anything.
* Never touches a security challenge or a login screen: it stops, pauses that
  app for 12 hours and logs it, and the user clears it on the phone.
* Contact -> Email opens a draft in the phone's email app; the address is read
  from it and the draft is discarded.
* Instagram profiles get 3 seconds to show Contact, then one refresh and 3 more.
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

from .cache import Cache

log = logging.getLogger(__name__)

DEVICE_NAME = "Galaxy A20e"
INSTAGRAM = "com.instagram.android"
FACEBOOK = "com.facebook.katana"
EMAIL_APPS = ("com.google.android.gm", "com.samsung.android.email.provider")
SETTLE_S = 3.0  # how long a profile gets to show its Contact button
GAP = (10.0, 20.0)
STATE_NS = "social-state"
APP_PAUSE = 12 * 3600
# Screens that need the user, never the worker.
STOP_SCREEN = re.compile(r"challenge|checkpoint|login|signup|nux|twofac|captcha|confirm", re.I)
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
BOUNDS = re.compile(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]")


@dataclass
class Node:
    text: str
    desc: str
    rid: str
    package: str
    clickable: bool
    center: tuple[int, int]

    @property
    def label(self) -> str:
        return (self.text or self.desc).strip()


@dataclass
class AppLookup:
    """What the phone showed for one profile."""
    emails: dict[str, str] = field(default_factory=dict)  # address -> "contact" | "page"
    context: str = ""
    blocked: str | None = None  # why the app wasn't usable


def parse_dump(xml: str) -> list[Node]:
    start, end = xml.find("<?xml"), xml.rfind("</hierarchy>")
    if start < 0 or end < 0:
        return []
    root = ET.fromstring(xml[start:end + len("</hierarchy>")])
    nodes = []
    for n in root.iter("node"):
        m = BOUNDS.match(n.get("bounds", ""))
        center = ((int(m[1]) + int(m[3])) // 2, (int(m[2]) + int(m[4])) // 2) if m else (0, 0)
        nodes.append(Node(n.get("text", ""), n.get("content-desc", ""), n.get("resource-id", ""),
                          n.get("package", ""), n.get("clickable") == "true", center))
    return nodes


def emails_on_screen(nodes: list[Node]) -> list[str]:
    found: list[str] = []
    for n in nodes:
        for email in EMAIL.findall(f"{n.text} {n.desc}"):
            email = email.lower().rstrip(".")
            if email not in found:
                found.append(email)
    return found


def find_button(nodes: list[Node], *names: str) -> Node | None:
    wanted = {n.lower() for n in names}
    for n in nodes:
        if n.label.lower() in wanted and n.center != (0, 0):
            return n
    return None


def find_adb() -> str | None:
    local = Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "platform-tools" / "adb.exe"
    sdk = Path(os.environ.get("LOCALAPPDATA", "")) / "Android" / "Sdk" / "platform-tools" / "adb.exe"
    for candidate in (os.environ.get("EMAIL_FINDER_ADB"), shutil.which("adb"), str(local), str(sdk)):
        if candidate and Path(candidate).is_file():
            return candidate
    return None


class Galaxy:
    def __init__(self, cache: Cache, adb: str, serial: str | None = None, daily_limit: int = 150) -> None:
        self.cache, self.adb, self.serial, self.daily_limit = cache, adb, serial, daily_limit
        self._lock = asyncio.Lock()
        self._last = 0.0

    # ── adb plumbing ─────────────────────────────────────────────────────────

    async def _run(self, *args: str, timeout: float = 25) -> str:
        cmd = [self.adb] + (["-s", self.serial] if self.serial else []) + list(args)
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.STDOUT)
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            proc.kill()
            raise
        return out.decode("utf-8", errors="replace")

    async def _shell(self, command: str, timeout: float = 25) -> str:
        return await self._run("shell", command, timeout=timeout)

    async def _screen(self) -> list[Node]:
        for _ in range(2):
            await self._shell("uiautomator dump /sdcard/ef-ui.xml >/dev/null 2>&1")
            nodes = parse_dump(await self._run("exec-out", "cat", "/sdcard/ef-ui.xml"))
            if nodes:
                return nodes
            await asyncio.sleep(1)
        return []

    async def _foreground(self) -> str:
        out = await self._shell("dumpsys activity activities | grep -m1 mResumedActivity")
        m = re.search(r"u0 (\S+?)/(\S+?)[ }]", out)
        return f"{m[1]}/{m[2]}" if m else ""

    async def _tap(self, node: Node) -> None:
        await self._shell(f"input tap {node.center[0]} {node.center[1]}")

    async def _refresh(self) -> None:
        await self._shell("input swipe 360 450 360 1250 350")  # pull to refresh

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

    # ── pacing and pauses ────────────────────────────────────────────────────

    def paused_for(self, app: str) -> float:
        state = self.cache.get(STATE_NS, f"{app}-app-pause") or {}
        return max(0.0, float(state.get("until", 0)) - time.time())

    def _pause(self, app: str, why: str) -> None:
        self.cache.set(STATE_NS, f"{app}-app-pause", {"until": time.time() + APP_PAUSE, "why": why}, 30 * 86400)
        log.warning("%s: the %s app shows %s. It needs you on the phone; the worker leaves it alone for "
                    "%d h.", DEVICE_NAME, app.title(), why, APP_PAUSE // 3600)

    async def _turn(self, app: str) -> str | None:
        """None when the phone may be used now (after the gap), else why not."""
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
            return name
        return None

    # ── Instagram ────────────────────────────────────────────────────────────

    async def instagram(self, handle: str) -> AppLookup:
        async with self._lock:
            why = await self._turn("instagram")
            if why:
                return AppLookup(blocked=why)
            try:
                return await self._instagram(handle)
            finally:
                await self._shell("input keyevent KEYCODE_HOME")

    async def _instagram(self, handle: str) -> AppLookup:
        result = AppLookup()
        await self._shell(f"am start -a android.intent.action.VIEW -d https://www.instagram.com/{handle}/ -p {INSTAGRAM}")
        contact = None
        for attempt in range(2):
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
            for email in await self._open_contact(contact):
                result.emails[email] = "contact"
        return result

    async def _open_contact(self, button: Node) -> list[str]:
        """Contact (or Email) button -> the address it holds."""
        await self._tap(button)
        await asyncio.sleep(1.5)
        sheet = await self._screen()
        found = emails_on_screen(sheet)
        if found:
            return found
        email_option = find_button(sheet, "Email", "Send email", "Email address")
        if email_option is None and button.label.lower() != "email":
            return []
        if email_option is not None:
            await self._tap(email_option)
        await asyncio.sleep(2.5)
        draft = await self._screen()
        found = emails_on_screen([n for n in draft if n.package in EMAIL_APPS])
        await self._discard_draft(draft)
        return found

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

    async def facebook(self, url: str) -> AppLookup:
        async with self._lock:
            why = await self._turn("facebook")
            if why:
                return AppLookup(blocked=why)
            try:
                return await self._facebook(url)
            finally:
                await self._shell("input keyevent KEYCODE_HOME")

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
