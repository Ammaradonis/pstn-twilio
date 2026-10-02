"""Where martial arts school owners' emails turn up (from email-hunt.txt).

Highest yield is the school's own site and its business listings; then
federation/association member directories, martial-arts directories,
tournament and team pages, and public social profiles. The engine searches
these in that order and only reads pages that are public without a login.

Sources exhaustively derived from email-hunt.txt:
  - National & multi-style federations (USMAF, USAWKF, MATA, BMABA, etc.)
  - Dedicated martial-arts directories (USADOJO, themartialartsdirectory.com, etc.)
  - Tournament platforms (Smoothcomp, Kihapp, Tapology, etc.)
  - Community and networking (MATA school owners, Facebook groups)
  - General business listings (Yelp, YP, Yell, BBB, etc.)
"""

from __future__ import annotations

import re
from functools import lru_cache
from urllib.parse import urlsplit
from .config import REPO_ROOT

# ── General martial-arts directories (global) ─────────────────────────────────

DIRECTORIES_GENERAL = [
    "usadojo.com",                   # USADOJO / Martial Arts Schools Directory (MATA)
    "bestmartialartsschools.com",    # MATA — Best Martial Arts Schools
    "martialartsteachers.com",       # MATA — Martial Arts Teachers
    "themartialartsdirectory.com",   # Claims 63,000+ schools worldwide
    "martialartsdirectory.org",
    "dojos.info",
    "dojos.com",
    "dojomap.com",
    "dojoatlas.com",
    "worldmartialartsmedia.com",     # World Martial Arts Media directory/articles
    # Additional from email-hunt.txt
    "usamartialartists.org",         # Profile pages — often include instructor email
    "martialartsschoolsguide.com",
    "martialartsinfo.com",
]

# ── US-specific directories and business listings ─────────────────────────────

DIRECTORIES_US = [
    "usmaf.org",                     # United States Martial Arts Federation — school directory
    "usawkf.org",                    # USA Wushu Kungfu Federation — school search with emails
    "usamartialartists.org",         # Profiles of US martial artists + schools
    "yellowpages.com",
    "yelp.com",
    "manta.com",
    "chamberofcommerce.com",
    "bbb.org",
    "mapquest.com",
    "angieslist.com",
    "thumbtack.com",
    "homeadvisor.com",
    # Tournament/federation crossovers that list school owners
    "atamartialarts.com",            # ATA chain — lists school owners / chief instructors
    "themat.com",                    # Wrestling / grappling school listings
]

# ── UK-specific directories and business listings ─────────────────────────────

DIRECTORIES_UK = [
    "bmaba.org.uk",                  # British Martial Arts & Boxing Association — national register
    "yell.com",
    "freeindex.co.uk",
    "thomsonlocal.com",
    "cylex-uk.co.uk",
    "scoot.co.uk",
    "192.com",
    "britishmartialarts.co.uk",
    # Additional UK sources
    "brownbook.net",
    "hotfrog.co.uk",
    "touching.co.uk",
    "themartialartsdirectory.co.uk",
    "englandsportsweb.co.uk",
]

# ── Style-specific federations & tournament platforms ─────────────────────────
#
# Each entry: (style pattern, list of domains)
# Consumed by engine._search_federations() and directory_sites().
#
BY_STYLE: list[tuple[re.Pattern[str], list[str]]] = [
    (
        re.compile(r"jiu.?jitsu|bjj|grappl|submission|gracie", re.I),
        ["ibjjf.com", "smoothcomp.com", "bjjheroes.com", "ibjjfdb.com", "bjjfanatics.com"],
    ),
    (
        re.compile(r"taekwon|tkd|hapkido|tang soo|kukkiwon", re.I),
        ["worldtaekwondo.org", "usatkd.org", "britishtaekwondo.org.uk", "wtftkd.com"],
    ),
    (
        re.compile(r"karate|kempo|kenpo|shotokan|wado|kyokushin|goju|uechi|shito", re.I),
        ["iskf.com", "wkf.net", "englishkaratefederation.com", "americankarate.com", "wkc.org"],
    ),
    (
        re.compile(r"kung ?fu|wushu|wing ?chun|tai ?chi|sanda|lion ?dance", re.I),
        ["usawkf.org", "tcuk.org", "usawkf.com", "wkf.net"],
    ),
    (
        re.compile(r"judo", re.I),
        ["usajudo.com", "britishjudo.org.uk", "ijf.org"],
    ),
    (
        re.compile(r"mma|mixed martial|kickbox|muay thai|boxing", re.I),
        ["tapology.com", "smoothcomp.com", "wmafighter.com"],
    ),
    (
        re.compile(r"krav", re.I),
        ["kravmaga.com", "kravmagauk.com", "ikmf.com"],
    ),
    (
        re.compile(r"aikido", re.I),
        ["usaf-aikido.org", "bab.org.uk", "aikiweb.com"],
    ),
    (
        re.compile(r"ata\b|songahm", re.I),
        ["atamartialarts.com", "ataonline.com"],
    ),
    (
        re.compile(r"ninjutsu|ninja|bujinkan|togakure", re.I),
        ["bujinkan.com"],
    ),
    (
        re.compile(r"capoeira", re.I),
        ["capoeira.com"],
    ),
    (
        re.compile(r"systema|sambo", re.I),
        ["russianmartialart.com"],
    ),
    (
        re.compile(r"wrestling|grappling", re.I),
        ["themat.com", "flowrestling.org"],
    ),
    (
        re.compile(r"fencing|épée|foil|sabre", re.I),
        ["usfencing.org", "britishfencing.com"],
    ),
]

# Re-exported alias for engine.py import
FEDERATION_SITES_BY_STYLE = BY_STYLE

# Federation domains for general queries (style unknown or multi-style)
FEDERATION_SITES_GENERAL: list[str] = [
    "usmaf.org",
    "usawkf.org",
    "usamartialartists.org",
    "bestmartialartsschools.com",
    "martialartsteachers.com",
    "usadojo.com",
    "worldmartialartsmedia.com",
    "themartialartsdirectory.com",
    "bmaba.org.uk",
    "britishmartialarts.co.uk",
]

# ── Pages behind a login / never show emails to the public: snippets only ─────

SNIPPET_ONLY_HOSTS = {
    "facebook.com",
    "instagram.com",
    "linkedin.com",
    "yelp.com",
    "yelp.co.uk",
    "nextdoor.com",
    "tiktok.com",
    "x.com",
    "twitter.com",
    "google.com",
    "maps.google.com",
}

SOCIAL_HOSTS = {"facebook.com", "instagram.com", "fb.com", "m.facebook.com"}

LINK_IN_BIO_HOSTS = {"linktr.ee", "beacons.ai", "linkin.bio", "lnk.bio", "taplink.cc", "solo.to"}

# Hosts that are platforms (not a school's own domain): an email on another
# domain is not evidence of a mismatch for these.
PLATFORM_HOSTS = {
    "wixsite.com",
    "squarespace.com",
    "godaddysites.com",
    "weebly.com",
    "business.site",
    "sites.google.com",
    "wordpress.com",
    "webflow.io",
    "carrd.co",
    "jimdosite.com",
}

# Booking/membership software, marketplaces and media: they list schools but
# are never a school's own website, and their inboxes are the vendor's.
VENDOR_HOSTS = {
    "wellnessliving.com", "mindbodyonline.com", "mindbody.io", "gymdesk.com", "zenplanner.com",
    "sparkmembership.com", "kicksite.net", "ustudioapp.com", "pike13.com", "glofox.com",
    "teamup.com", "classpass.com", "groupon.com", "groupon.co.uk", "wodify.com", "gymmaster.com",
    "clubright.co.uk", "clubbuzz.co.uk", "myclubhouse.co.uk", "spond.com", "clubspark.lta.org.uk",
    "eventbrite.com", "eventbrite.co.uk", "meetup.com", "tripadvisor.com", "tripadvisor.co.uk",
    "univision.com", "patch.com", "nextdoor.com", "angi.com", "thumbtack.com", "birdeye.com",
    "trustpilot.com", "mapquest.com", "foursquare.com", "wikipedia.org", "youtube.com",
}

# Tournament / event platforms: great for finding a team's website, but
# addresses on their pages belong to event organisers, not the schools.
NO_EMAIL_HOSTS = {
    "smoothcomp.com", "kihapp.com", "trackitt.com", "martialmatch.com",
    "eventbrite.com", "eventbrite.co.uk", "ibjjfdb.com", "bjjcompsystem.com",
    "tapology.com",
}

FREE_MAIL_DOMAINS = {
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "hotmail.com",
    "hotmail.co.uk", "outlook.com", "live.com", "live.co.uk", "msn.com", "aol.com", "icloud.com",
    "me.com", "mac.com", "btinternet.com", "sky.com", "talktalk.net", "virginmedia.com",
    "protonmail.com", "proton.me", "gmx.com", "gmx.co.uk", "mail.com", "zoho.com", "comcast.net",
    "att.net", "sbcglobal.net", "verizon.net", "cox.net", "charter.net", "bellsouth.net",
    "aol.co.uk", "outlook.co.uk", "btopenworld.com", "blueyonder.co.uk", "ntlworld.com",
    "virgin.net", "tiscali.co.uk", "talk21.com", "o2.co.uk", "orange.net", "plus.net",
    "fsmail.net", "yahoo.ca", "rocketmail.com", "earthlink.net", "optonline.net",
    "frontier.com", "windstream.net", "roadrunner.com", "rr.com", "twc.com", "suddenlink.net",
    "centurylink.net", "embarqmail.com", "q.com", "juno.com",
}


def directory_sites(country: str, category: str, title: str) -> list[str]:
    """Most relevant directories for one school: style-specific first."""
    text = f"{category} {title}"
    sites: list[str] = []
    for pattern, hosts in BY_STYLE:
        if pattern.search(text):
            sites.extend(hosts)
    sites.extend(DIRECTORIES_UK if country == "GB" else DIRECTORIES_US)
    sites.extend(DIRECTORIES_GENERAL)
    sites.extend(["smoothcomp.com", "kihapp.com"])
    sites.extend(request_sources())
    seen: set[str] = set()
    return [s for s in sites if not (s in seen or seen.add(s))]  # type: ignore[func-returns-value]


@lru_cache(maxsize=1)
def request_sources() -> list[str]:
    """Keep the user's source document part of the running engine."""
    path = REPO_ROOT / "email-hunt.txt"
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8-sig")
    # Markdown such as [https://host](https://host/path) is not itself a URL.
    hosts = re.findall(r"https?://([a-zA-Z0-9.-]+)", text)
    hosts += re.findall(r"\b(?:[a-z0-9-]+\.)+(?:com|org|net|co\.uk)\b", text, re.I)
    return sorted({h.lower().removeprefix("www.") for h in hosts if h and h.lower().removeprefix("www.") not in SOCIAL_HOSTS})


def host_matches(host: str, domains: set[str] | list[str]) -> bool:
    host = host.lower().removeprefix("www.").removeprefix("m.")
    return any(host == d or host.endswith("." + d) for d in domains)
