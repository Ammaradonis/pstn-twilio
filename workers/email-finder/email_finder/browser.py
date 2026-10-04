"""A real installed browser for pages that check who is visiting (Google,
Facebook, Instagram): Microsoft Edge, then Chrome, then Playwright's Chromium,
headless, with a persistent profile, and nothing in its signals that says
"automated".

Headless browsers call themselves "HeadlessChrome"; the browser is relaunched
once with its own user agent minus that word. Nothing else is disguised: a
user agent that contradicts the browser's other signals gets a CAPTCHA.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path

log = logging.getLogger(__name__)

BROWSERS = ("msedge", "chrome", None)  # None: Playwright's bundled Chromium
IPHONE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1"
)


def profile_for(profile_dir: Path, channel: str | None) -> Path:
    """Each browser keeps its own profile folder: one browser can't read the
    cookies another saved (Edge and Chrome encrypt them with their own key), so
    sharing a folder silently signs the fallback browser out."""
    if channel == BROWSERS[0]:
        return profile_dir
    return profile_dir.with_name(f"{profile_dir.name}-{channel or 'chromium'}")


async def launch_persistent(pw, profile_dir: Path, *, locale: str = "en-US",
                            viewport: dict | None = None, timeout: float = 60_000, **options):
    """(context, channel, profile folder used) for the first browser that
    starts; raises the last launch error when none does."""
    last_error: Exception | None = None
    for channel in BROWSERS:
        user_agent, ctx = None, None
        profile = profile_for(profile_dir, channel)
        try:
            for _ in range(2):
                ctx = await pw.chromium.launch_persistent_context(
                    str(profile), channel=channel, headless=True, locale=locale,
                    viewport=viewport or {"width": 1366, "height": 900}, user_agent=user_agent,
                    args=["--disable-blink-features=AutomationControlled"],
                    ignore_default_args=["--enable-automation"],
                    timeout=timeout,  # a hung launch falls through to the next browser
                    **options,
                )
                page = ctx.pages[0] if ctx.pages else await ctx.new_page()
                agent = await page.evaluate("navigator.userAgent")
                if "HeadlessChrome" not in agent:
                    return ctx, channel, profile
                await ctx.close()
                ctx = None
                user_agent = agent.replace("HeadlessChrome", "Chrome")
                major = (re.search(r"Chrome/(\d+)", user_agent) or [None, "140"])[1]
                if channel == "msedge" and "Edg/" not in user_agent:
                    user_agent += f" Edg/{major}.0.0.0"
        except Exception as err:  # noqa: BLE001 - not installed, or it hung
            log.info("Couldn't start %s: %s", channel or "Chromium",
                     (str(err).strip().splitlines() or [""])[0][:160])
            last_error = err
            if ctx is not None:
                try:
                    await ctx.close()
                except Exception:  # noqa: BLE001
                    pass
    raise last_error or RuntimeError("no browser could be started")


async def emulate_iphone(ctx, page) -> None:
    """Make one page an iPhone through and through, the way browser developer
    tools do: user agent and platform, a 390x844 touch screen at 3x, and no
    desktop "client hints". Changing only the user-agent header leaves the
    page's JavaScript reporting a Windows desktop browser, which Meta flags."""
    cdp = await ctx.new_cdp_session(page)
    await cdp.send("Emulation.setUserAgentOverride", {
        "userAgent": IPHONE_UA, "acceptLanguage": "en-US,en;q=0.9", "platform": "iPhone",
    })
    await cdp.send("Emulation.setDeviceMetricsOverride", {
        "width": 390, "height": 844, "deviceScaleFactor": 3, "mobile": True,
        "screenWidth": 390, "screenHeight": 844,
    })
    await cdp.send("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5})
    # Safari has no navigator.userAgentData; Chromium leaves an empty one.
    await page.add_init_script("try { delete Navigator.prototype.userAgentData } catch (e) {}")
