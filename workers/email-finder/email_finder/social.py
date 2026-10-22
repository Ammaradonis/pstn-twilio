"""Social profile URLs for every platform the sheets carry a column for.

The email finder originally knew only Facebook and Instagram, because those were
the two networks it needed to sign in to for a business's *email*. Enrichment
mode fills the sheet's facebook/instagram/youtube/twitter/linkedin/tiktok columns,
so it needs to recognise a profile link for any of them and put it back into the
shape the sheet expects.

Two different notions of "social host" live here on purpose:

* `PROFILE_HOSTS` — every network a spreadsheet column exists for. Used for
  *capture*: a link found on a school's site or in a search result.
* `SIGNED_IN_HOSTS` — only Facebook and Instagram, the networks the worker has
  exported cookies for. Used when deciding which browser context to sign in to.
  Keeping these apart is what stops a YouTube link being offered to the
  Facebook cookie importer.
"""

from __future__ import annotations

from urllib.parse import urlsplit

# Every platform the API can write to a sheet column (see ENRICHMENT_COLUMNS).
PLATFORMS = ("facebook", "instagram", "youtube", "twitter", "linkedin", "tiktok")

PROFILE_HOSTS: dict[str, frozenset[str]] = {
    "facebook": frozenset({"facebook.com", "fb.com", "fb.me", "m.facebook.com"}),
    "instagram": frozenset({"instagram.com", "instagr.am"}),
    "youtube": frozenset({"youtube.com", "youtu.be", "m.youtube.com"}),
    "twitter": frozenset({"twitter.com", "x.com", "mobile.twitter.com"}),
    "linkedin": frozenset({"linkedin.com", "lnkd.in"}),
    "tiktok": frozenset({"tiktok.com", "vm.tiktok.com"}),
}

# Networks with an exported cookies.txt sign-in (cookies.py) and a browser context.
SIGNED_IN_HOSTS: dict[str, frozenset[str]] = {
    "facebook": PROFILE_HOSTS["facebook"],
    "instagram": PROFILE_HOSTS["instagram"],
}

# Path prefixes that are the network's own pages, never a school's profile.
_NETWORK_PAGES = frozenset({
    "share", "sharer", "sharer.php", "watch", "events", "groups", "login",
    "login.php", "signup", "help", "policy.php", "privacy", "terms", "legal",
    "about", "business", "ads", "developer", "developers", "settings", "home",
    "home.php", "story.php", "permalink.php", "photo.php", "reel", "reels",
    "explore", "accounts", "p", "pages", "people", "profile.php", "hashtag",
    "feed", "playlist", "results", "channel", "c", "user", "intent", "i",
    "m", "m.youtube.com", "embed", "shorts",
})

# A profile path must exist for these networks (YouTube/LinkedIn allow bare /@handle).
_NEEDS_PATH = frozenset({"facebook", "instagram", "tiktok"})

# Trailing path segments that are tabs of a profile, not part of its identity.
_TABS = frozenset({
    "about", "contact", "photos", "videos", "reels", "followers", "following",
    "posts", "reviews", "menu", "services", "shop", "team", "store", "tagged",
    "about_contact_and_basic_info", "details", "insights", "shorts", "streams",
    "featured", "playlists", "community", "channels", "jobs", "people",
})


def _bare_host(url: str) -> str:
    try:
        return urlsplit(url if "//" in url else "https://" + url).netloc.lower().split(":")[0]
    except ValueError:
        return ""


def platform_of(url: str) -> str | None:
    """Which sheet platform this URL belongs to, or None if it is not a profile host."""
    host = _bare_host(url)
    if not host:
        return None
    for platform, hosts in PROFILE_HOSTS.items():
        if host in hosts:
            return platform
        # A subdomain (m., mobile., www.) of a known network.
        if any(host.endswith("." + h) for h in hosts):
            return platform
    return None


def is_profile(url: str) -> bool:
    """Whether a URL is a *profile* rather than the network's own pages.

    Used both to accept a link found on a school's website and to reject a search
    result that points at a network page (a share dialog, a help page, a feed).
    """
    platform = platform_of(url)
    if not platform:
        return False
    try:
        parts = urlsplit(url if "//" in url else "https://" + url)
    except ValueError:
        return False
    path = parts.path.strip("/")
    if not path:
        return platform not in _NEEDS_PATH
    # profile.php?id=… is a real Facebook profile.
    if platform == "facebook" and path.split("/")[0].lower() == "profile.php":
        return "id=" in (parts.query or "")
    head = path.split("/")[0].lower()
    # Match the stem too, so "share.php", "help.php", "login.php" are caught.
    if head in _NETWORK_PAGES or head.rsplit(".", 1)[0] in _NETWORK_PAGES:
        return False
    return True


def normalise(url: str) -> str:
    """The canonical profile URL a sheet cell should hold.

    Drops tracking queries, mobile hosts, and trailing tabs so the same profile
    found through two methods collapses to one value instead of two.
    """
    platform = platform_of(url)
    if not platform:
        return url.split("?")[0] if "?" in url else url
    try:
        parts = urlsplit(url if "//" in url else "https://" + url)
    except ValueError:
        return url
    host = parts.netloc.lower()
    # Mobile/legacy hosts rewrite to the canonical one.
    if platform == "facebook":
        host = "www.facebook.com"
    elif host.startswith(("m.", "mobile.")):
        host = host.split(".", 1)[1]
    path = parts.path
    # Trim a trailing tab, and the trailing slash, so one profile always has one
    # canonical value no matter which method (or footer link) found it. This is
    # the form written into the sheet, so "/dojo" and "/dojo/" must not diverge.
    segments = [s for s in path.split("/") if s]
    while len(segments) > 1 and segments[-1].lower() in _TABS:
        segments = segments[:-1]
    path = "/" + "/".join(segments)
    if platform == "twitter":
        pass  # x.com and twitter.com are both kept as found
    query = parts.query if "profile.php" in path else ""
    return f"https://{host}{path}" + (f"?{query}" if query else "")


def handle_from_url(url: str) -> str | None:
    """The Instagram handle in a profile URL, for the phone's app lookup."""
    if not is_profile(url) or platform_of(url) != "instagram":
        return None
    path = urlsplit(url).path.strip("/")
    handle = path.split("/")[0] if path else ""
    return handle or None


def candidate_handles(name: str, website: str | None) -> list[str]:
    """Plausible Instagram handles for a school, cheapest guess first.

    Enrichment mode uses these only as *guesses* to hand to the phone: a guess is
    confirmed by reading the profile in the real app, never trusted on its own.
    ``must_match`` in the engine is what enforces that.

    Deliberately self-contained (no import from engine.py) so this module stays
    a leaf: engine.py imports it, and a cycle would break the import.
    """
    out: list[str] = []
    seen: set[str] = set()

    def add(value: str | None) -> None:
        if not value:
            return
        cleaned = "".join(ch for ch in value.lower() if ch.isalnum() or ch in "._")
        cleaned = cleaned.strip("._")
        if 3 <= len(cleaned) <= 30 and cleaned not in seen:
            seen.add(cleaned)
            out.append(cleaned)

    words = [
        w.lower() for w in
        "".join(ch if ch.isalnum() else " " for ch in (name or "")).split()
        if len(w) > 1
    ][:6]
    if words:
        add("".join(words))
        add("_".join(words))
        add(words[0])
        if len(words) > 1:
            add(words[0] + words[1])
            add(words[0] + "_" + words[1])
    host = _bare_host(website or "")
    if host:
        label = host.removeprefix("www.").split(".")[0]
        add(label)
        add(label.replace("-", ""))
        add(label.replace("-", "_"))
    return out[:6]
