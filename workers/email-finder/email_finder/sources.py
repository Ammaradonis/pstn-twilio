"""Where martial arts school owners' emails turn up (from email-hunt.txt).

Highest yield is the school's own site and its business listings; then
federation/association member directories, martial-arts directories,
tournament and team pages, and public social profiles. The engine searches
these in that order and only reads pages that are public without a login.
"""

from __future__ import annotations

import re

# Martial-arts directories and associations that list schools with contacts.
DIRECTORIES_GENERAL = [
    "usadojo.com",  # USADOJO / Martial Arts Schools Directory
    "bestmartialartsschools.com",  # MATA
    "martialartsteachers.com",  # MATA
    "themartialartsdirectory.com",
    "martialartsdirectory.org",
    "dojos.info",
    "dojos.com",
    "dojomap.com",
    "dojoatlas.com",
    "worldmartialartsmedia.com",
]

DIRECTORIES_US = [
    "usmaf.org",  # United States Martial Arts Federation
    "usawkf.org",  # USA Wushu Kungfu Federation
    "usamartialartists.org",
    "yellowpages.com",
    "manta.com",
    "chamberofcommerce.com",
    "bbb.org",
    "mapquest.com",
]

DIRECTORIES_UK = [
    "bmaba.org.uk",  # British Martial Arts & Boxing Association register
    "yell.com",
    "freeindex.co.uk",
    "thomsonlocal.com",
    "cylex-uk.co.uk",
    "scoot.co.uk",
]

# Style-specific federations, tournament platforms and team registries.
BY_STYLE: list[tuple[re.Pattern[str], list[str]]] = [
    (re.compile(r"jiu.?jitsu|bjj|grappl|submission", re.I), ["ibjjf.com", "smoothcomp.com", "bjjheroes.com"]),
    (re.compile(r"taekwon|tkd|hapkido|tang soo", re.I), ["worldtaekwondo.org", "usatkd.org", "britishtaekwondo.org.uk"]),
    (re.compile(r"karate|kempo|kenpo|shotokan|wado|kyokushin", re.I), ["iskf.com", "wkf.net", "englishkaratefederation.com"]),
    (re.compile(r"kung ?fu|wushu|wing ?chun|tai ?chi|sanda", re.I), ["usawkf.org", "tcuk.org"]),
    (re.compile(r"judo", re.I), ["usajudo.com", "britishjudo.org.uk"]),
    (re.compile(r"mma|mixed martial|kickbox|muay thai|boxing", re.I), ["tapology.com", "smoothcomp.com"]),
    (re.compile(r"krav", re.I), ["kravmaga.com", "kravmagauk.com"]),
    (re.compile(r"aikido", re.I), ["usaf-aikido.org", "bab.org.uk"]),
    (re.compile(r"ata\b|songahm", re.I), ["atamartialarts.com"]),
]

# Pages behind a login, or that never show emails to the public: use their
# search snippets only, never fetch them.
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

# Hosts that are platforms, not a school's own domain: an email on another
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

# Tournament/event platforms: great for finding a team's website, but the
# addresses on their pages belong to event organisers, not the schools.
NO_EMAIL_HOSTS = {"smoothcomp.com", "kihapp.com", "trackitt.com", "martialmatch.com", "eventbrite.com",
                  "eventbrite.co.uk", "ibjjfdb.com", "bjjcompsystem.com", "tapology.com"}

FREE_MAIL_DOMAINS = {
    "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "ymail.com", "hotmail.com",
    "hotmail.co.uk", "outlook.com", "live.com", "live.co.uk", "msn.com", "aol.com", "icloud.com",
    "me.com", "mac.com", "btinternet.com", "sky.com", "talktalk.net", "virginmedia.com",
    "protonmail.com", "proton.me", "gmx.com", "gmx.co.uk", "mail.com", "zoho.com", "comcast.net",
    "att.net", "sbcglobal.net", "verizon.net", "cox.net", "charter.net", "bellsouth.net",
    "aol.co.uk", "outlook.co.uk", "btopenworld.com", "blueyonder.co.uk", "ntlworld.com", "virgin.net",
    "tiscali.co.uk", "talk21.com", "o2.co.uk", "orange.net", "plus.net", "fsmail.net", "yahoo.ca",
    "rocketmail.com", "earthlink.net", "optonline.net", "frontier.com", "windstream.net", "roadrunner.com",
    "rr.com", "twc.com", "suddenlink.net", "centurylink.net", "embarqmail.com", "q.com", "juno.com",
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
    seen: set[str] = set()
    return [s for s in sites if not (s in seen or seen.add(s))]


def host_matches(host: str, domains: set[str] | list[str]) -> bool:
    host = host.lower().removeprefix("www.").removeprefix("m.")
    return any(host == d or host.endswith("." + d) for d in domains)
