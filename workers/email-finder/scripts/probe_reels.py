"""Read the real Instagram Reels screen so the ambient session's selectors can be
written against what the app actually shows (IG 449, Android 11).

Read-only on purpose: it opens the app, taps only the Reels tab and the
overflow ("More options") button, swipes once, and presses Back/Home. It never
likes, follows, marks anything interested, or types -- nothing on screen changes
state. One process at a time, via the same galaxy.lock the worker uses, and it
stops on sight of a login or challenge screen exactly as the worker does.

  .venv/Scripts/python scripts/probe_reels.py

Writes .cache/reel-probe.json (raw dumps) and prints the labelled nodes of each
screen, so selectors can be checked against the real thing.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.android import STOP_SCREEN, Galaxy, find_adb, find_button, parse_dump  # noqa: E402
from email_finder.cache import Cache  # noqa: E402
from email_finder.config import CACHE_DIR  # noqa: E402

SETTLE = 4.0
REELS_TAB = re.compile(r"^(reels?|clips)$", re.I)
OUT = CACHE_DIR / "reel-probe.json"


async def dump(phone: Galaxy, label: str, shots: dict[str, str]) -> list:
    await asyncio.sleep(SETTLE)
    await phone._shell("uiautomator dump /sdcard/ef-ui.xml >/dev/null 2>&1")
    xml = await phone._run("exec-out", "cat", "/sdcard/ef-ui.xml")
    shots[label] = xml
    nodes = parse_dump(xml)
    print(f"\n=== {label} :: {await phone._foreground()} :: {len(nodes)} nodes ===")
    for n in nodes:
        if n.label or "reel" in n.rid or "clips" in n.rid or "username" in n.rid or "profile" in n.rid:
            print(f"  {str(n.center):>12}  click={str(n.clickable):5}  rid={n.rid[:64]:64}  "
                  f"text={n.text[:40]!r} desc={n.desc[:40]!r}")
    return nodes


async def probe() -> int:
    adb = find_adb()
    if not adb:
        print("adb not found")
        return 1
    phone = Galaxy(Cache(CACHE_DIR / "probe.sqlite"), adb, None, 150)
    if not await phone._hold_phone(wait_s=0):
        print("another process holds galaxy.lock; try again later")
        return 0
    shots: dict[str, str] = {}
    try:
        if not await phone.available():
            print("phone unavailable (offline, or locked)")
            return 1
        out = await phone._shell("cmd package resolve-activity --brief com.instagram.android")
        component = out.strip().splitlines()[-1].strip()
        print(f"launcher component: {component}")
        await phone._shell(f"am start -n {component}")
        nodes = await dump(phone, "app-opened", shots)
        activity = await phone._foreground()
        if STOP_SCREEN.search(activity.partition("/")[2]):
            phone._pause("instagram", f"a {activity.rsplit('.', 1)[-1]} screen")
            print("login/challenge screen: stopping without touching it")
            return 0
        tab = next((n for n in nodes if REELS_TAB.match(n.label) and n.center != (0, 0)), None)
        if tab is None:
            print("no Reels tab found on this screen")
            return 0
        await phone._tap(tab)
        nodes = await dump(phone, "reels-tab", shots)
        await phone._shell("input swipe 360 1150 360 480 240")  # one page down
        nodes = await dump(phone, "after-one-swipe", shots)
        menu = find_button(nodes, "More options", "More", "Options")
        if menu is None:
            print("no overflow button found on the reel")
            return 0
        await phone._tap(menu)
        await dump(phone, "overflow-menu", shots)
        await phone._shell("input keyevent KEYCODE_BACK")
        await asyncio.sleep(1)
        return 0
    finally:
        await phone._shell("input keyevent KEYCODE_HOME")
        phone._release_phone()
        OUT.write_text(json.dumps(shots, indent=1), encoding="utf-8")
        print(f"\nraw dumps -> {OUT}")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    raise SystemExit(asyncio.run(probe()))
