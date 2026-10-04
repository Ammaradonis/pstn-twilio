"""Cookies exported from the user's own browser (cookies.txt, Netscape format,
as written by "Get cookies.txt"-style extensions).

Only the cookies of the hosts asked for are read; anything else in the file is
skipped. Each export is loaded into a browser profile once: the sites rotate
some session cookies afterwards, and re-adding the exported values would undo
that and look like a stolen session.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path

log = logging.getLogger(__name__)

FACEBOOK_HOSTS = {"facebook.com", "www.facebook.com", "m.facebook.com"}
INSTAGRAM_HOSTS = {"instagram.com", "www.instagram.com"}


def load_cookies(path: Path, hosts: set[str]) -> list[dict]:
    """The unexpired cookies set for exactly these hosts, in Playwright's format."""
    found: dict[tuple[str, str, str], dict] = {}
    now = time.time()
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        http_only = line.startswith("#HttpOnly_")
        if http_only:
            line = line[len("#HttpOnly_"):]
        elif line.startswith("#") or not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < 7:
            continue
        domain, _, cookie_path, secure, expires, name, value = parts[:7]
        if domain.lstrip(".").lower() not in hosts or not name:
            continue
        try:
            expiry = float(expires or 0)
        except ValueError:
            continue
        if 0 < expiry < now:
            continue
        secure_flag = secure.upper() == "TRUE"
        found[(domain, name, cookie_path)] = {
            "name": name, "value": value, "domain": domain, "path": cookie_path or "/",
            "expires": expiry if expiry > 0 else -1, "httpOnly": http_only, "secure": secure_flag,
            # Google's third-party-context cookies only work cross-site.
            "sameSite": "None" if secure_flag and name.startswith("__Secure-3P") else "Lax",
        }
    return list(found.values())


async def import_once(ctx, path: Path | None, hosts: set[str], profile_dir: Path, marker: str) -> int:
    """Add an export's cookies for these hosts to a browser context, unless this
    exact export was already imported into the profile. Returns how many were added."""
    if not path or not path.is_file():
        return 0
    stat = path.stat()
    stamp = f"{stat.st_mtime_ns}:{stat.st_size}"
    stamp_file = profile_dir / marker
    if stamp_file.is_file() and stamp_file.read_text(encoding="utf-8").strip() == stamp:
        return 0
    cookies = load_cookies(path, hosts)
    if not cookies:
        log.warning("%s has no unexpired cookies for %s", path.name, sorted(hosts)[0])
        return 0
    await ctx.add_cookies(cookies)
    profile_dir.mkdir(parents=True, exist_ok=True)
    stamp_file.write_text(stamp, encoding="utf-8")
    log.info("Loaded %d cookies from %s into the browser profile", len(cookies), path.name)
    return len(cookies)
