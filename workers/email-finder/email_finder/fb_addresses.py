"""Every address in "U.S. Conquest" and "The Official UK", for the Facebook
group search (fb_vocab.py).

The rule this module exists to enforce is simple: no address input is skipped.
Both workbooks are read tab by tab, and every non-empty row is turned into a
record even when its address is unusable, so the reason it cannot be searched
is recorded next to it instead of the row quietly vanishing. The vocab builder
then refuses to run unless every record reached at least one search phrase.

The address is assembled the way the API does it (sheets.service.ts,
`rowAddress`): take the address column, and append city / state / zip columns
that the address text does not already contain. A workbook whose addresses live
in three columns therefore yields the same string as one with a single column.

Read-only. The service account in gcp-creds.json is enough: no user OAuth token
is involved, and nothing is ever written back to a workbook.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .config import CACHE_DIR

log = logging.getLogger(__name__)

# The two workbooks, by the names the rest of the repo uses.
WORKBOOKS = {
    "U.S. Conquest": "1hEen_n9M27n5bjyXpsnaHXpvG7S5eHHmPl6HG2LhRnM",
    "The Official UK": "1RmfJeS9wj82LwvpNa5VdKRNwyQChzVyGwzLx31jP3ts",
}
SCOPES = ("https://www.googleapis.com/auth/spreadsheets.readonly",)
SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"
CHUNK_TABS = 20  # ranges per values:batchGet call
CACHE_FILE = CACHE_DIR / "fb-addresses.json"
CACHE_TTL_S = 7 * 86400

# Column headers, normalised the way sheets.util.normalizeHeader does it.
ADDRESS_HEADERS = ("address", "fulladdress", "streetaddress")
CITY_HEADERS = ("city", "town")
STATE_HEADERS = ("state", "statecode")
ZIP_HEADERS = ("zip", "zipcode", "postalcode", "postcode")
# The scrape exports carry a "target" column like "Grayson County, Texas, USA"
# or "Northamptonshire, England, UK". It is the county signal, and a county is
# the level at which regional Facebook groups are actually named.
TARGET_HEADERS = ("target", "county", "region")
SCHOOL_HEADERS = ("schoolname", "school", "businessname", "title", "name")
WEBSITE_HEADERS = ("websiteurl", "website", "url", "site", "web")
FACEBOOK_HEADERS = ("facebookurl", "facebook", "fb")
PHONE_HEADERS = ("phonenumber", "phone", "telephone", "tel", "phoneno")
CATEGORY_HEADERS = ("category", "type", "style")
SCHOOL_OWN_HEADERS = {"emailtype", "emailsource", "decisionmaker", "contactform"}

US_STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas",
    "CA": "California", "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware",
    "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii",
    "ID": "Idaho", "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas",
    "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi",
    "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
    "OR": "Oregon", "PA": "Pennsylvania", "RI": "Rhode Island",
    "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
    "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
    "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}
_STATE_BY_NAME = {name.casefold(): code for code, name in US_STATES.items()}

# 678 FM 120, Pottsboro, TX 75076  |  ... , TX 75076-1234
US_TAIL = re.compile(r"^(?P<state>[A-Z]{2})\s+(?P<zip>\d{5})(?:-\d{4})?$", re.I)
# 257 Harlestone Rd, Northampton NN5 6DD  |  London SW1A 1AA
UK_POSTCODE = re.compile(r"\b(?P<out>[A-Z]{1,2}\d[A-Z\d]?)\s?(?P<inward>\d[A-Z]{2})\b", re.I)
UK_NATIONS = ("england", "scotland", "wales", "northern ireland", "uk", "united kingdom")
COUNTY_SUFFIX = re.compile(r"\bcounty\b", re.I)


@dataclass
class Address:
    """One row's address, plus what the row tells us about the school."""

    source: str  # "U.S. Conquest" | "The Official UK"
    tab: str
    row: int  # 1-based, as Google Sheets shows it
    address: str  # assembled address, "" when the row has none
    city: str = ""
    county: str = ""
    state_code: str = ""
    state_name: str = ""
    postcode: str = ""
    postcode_district: str = ""
    country: str = ""  # "US" | "UK" | ""
    school: str = ""
    website: str = ""
    facebook: str = ""
    phone: str = ""
    category: str = ""
    # Why this row has no usable address, when it has none. A row with a reason
    # is still reported; only a row that is entirely blank is dropped.
    reason: str = ""
    notes: list[str] = field(default_factory=list)

    @property
    def usable(self) -> bool:
        return bool(self.address) and not self.reason


def _norm(header: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(header or "").casefold())


def _text(cell: object) -> str:
    return "" if cell is None else str(cell).strip()


def columns(headers: list[str]) -> dict[str, int]:
    """Index of the columns we read, using the same fallbacks as sheets.service.ts."""
    norm = [_norm(h) for h in headers]

    def exact(*names: str) -> int:
        return next((i for i, h in enumerate(norm) if h in names), -1)

    def contains(*needles: str) -> int:
        return next((i for i, h in enumerate(norm) if any(n in h for n in needles)), -1)

    return {
        "address": exact(*ADDRESS_HEADERS) if exact(*ADDRESS_HEADERS) != -1
        else contains("address"),
        "city": exact(*CITY_HEADERS),
        "state": exact(*STATE_HEADERS),
        "zip": exact(*ZIP_HEADERS),
        "target": exact(*TARGET_HEADERS),
        "school": exact(*SCHOOL_HEADERS) if exact(*SCHOOL_HEADERS) != -1
        else contains("school", "businessname"),
        "website": exact(*WEBSITE_HEADERS),
        "facebook": exact(*FACEBOOK_HEADERS),
        "phone": exact(*PHONE_HEADERS) if exact(*PHONE_HEADERS) != -1 else contains("phone"),
        "category": exact(*CATEGORY_HEADERS),
    }


def row_address(row: list[object], cols: dict[str, int]) -> str:
    """The address as the API builds it: the column, completed by city/state/zip."""
    address = _text(row[cols["address"]]) if cols["address"] != -1 else ""
    lower = address.casefold()
    extra = [
        _text(row[i])
        for i in (cols["city"], cols["state"], cols["zip"])
        if i != -1 and i < len(row)
    ]
    extra = [v for v in extra if v and v.casefold() not in lower]
    if extra:
        address = ", ".join(p for p in (address, *extra) if p)
    return address


def parse_address(address: str, source: str) -> dict[str, str]:
    """City / county / state / postcode / country, as far as the text allows.

    The parsers are deliberately forgiving: a Facebook search that uses "Austin"
    only needs the city to be right, and a leftover county or ZIP costs nothing.
    A part that cannot be read stays empty rather than being guessed.
    """
    out = {"city": "", "county": "", "state_code": "", "state_name": "",
           "postcode": "", "postcode_district": "", "country": "",
           "notes": []}
    text = (address or "").strip()
    if not text:
        return out
    parts = [p.strip() for p in text.split(",") if p.strip()]

    # United Kingdom: a postcode anywhere in the string is decisive.
    match = UK_POSTCODE.search(text)
    if match:
        out["country"] = "UK"
        out["postcode"] = f"{match['out'].upper()} {match['inward'].upper()}"
        out["postcode_district"] = match["out"].upper()
        # The town is whatever precedes the postcode inside the same comma part,
        # e.g. "Northampton NN5 6DD". Searching each part separately matters:
        # offsets from a match on the whole string would leave the postcode in.
        for part in reversed(parts):
            inside = UK_POSTCODE.search(part)
            if inside:
                town = re.sub(r"\s+", " ", part[: inside.start()]).strip(" ,-")
                if town and not any(n in town.casefold() for n in UK_NATIONS):
                    out["city"] = town
                break
        if not out["city"] and parts:
            # A part that is only the postcode: use the alphabetic part before it.
            out["city"] = next((p for p in reversed(parts) if not UK_POSTCODE.search(p)
                                and not any(n in p.casefold() for n in UK_NATIONS)), parts[0])
        for part in parts:
            if any(n in part.casefold() for n in UK_NATIONS):
                out["state_name"] = part.title()
                break
        return out

    # United States: "..., TX 75076" in the last part decides it.
    tail = parts[-1] if parts else ""
    match = US_TAIL.match(tail)
    if match:
        out["country"] = "US"
        out["state_code"] = match["state"].upper()
        out["state_name"] = US_STATES.get(out["state_code"], "")
        out["postcode"] = match["zip"]
        if len(parts) >= 2:
            out["city"] = parts[-2]
        return out

    # A source that says USA anywhere, or a workbook we know is American.
    looks_us = any(p.casefold() in ("usa", "us", "united states") for p in parts)
    looks_uk = any("uk" == p.casefold() or "united kingdom" == p.casefold() for p in parts)
    if looks_us or (source == "U.S. Conquest" and not looks_uk):
        out["country"] = "US"
        state = _STATE_BY_NAME.get((parts[-1] if parts else "").casefold())
        if state:
            out["state_code"], out["state_name"] = state, US_STATES[state]
            out["city"] = parts[-2] if len(parts) >= 2 else ""
        else:
            out["city"] = parts[-1] if parts else ""
            out["notes"].append("state not in address")
        return out
    if looks_uk or source == "The Official UK":
        out["country"] = "UK"
        out["city"] = parts[0] if parts else ""
        out["notes"].append("no postcode in address")
        return out
    out["city"] = parts[0] if parts else ""
    out["notes"].append("country unclear")
    return out


def target_parts(target: str) -> tuple[str, str]:
    """The locale a scrape row was filed under.

    "Grayson County, Texas, USA" -> ("Grayson", "Texas")
    "Northamptonshire, England, UK" -> ("Northamptonshire", "England")

    The `target` column is where counties live, and a county name is how the
    regional Facebook groups are actually titled ("Northamptonshire Small
    Business Owners"), so it earns its own search phrases.
    """
    if not target:
        return "", ""
    parts = [p.strip() for p in target.split(",") if p.strip()]
    county = ""
    for part in parts:
        if COUNTY_SUFFIX.search(part):
            county = COUNTY_SUFFIX.sub("", part).strip()
            break
    if not county:
        # UK rows name the county first and without the word "County"; a US row
        # that starts with its state or a postcode has no county at all.
        first = parts[0] if parts else ""
        plain = first.casefold() not in _STATE_BY_NAME \
            and first.casefold() not in UK_NATIONS \
            and not UK_POSTCODE.search(first) \
            and not US_TAIL.match(first)
        if plain and first:
            county = first
    region = next((p for p in parts if p.casefold() in _STATE_BY_NAME
                   or p.casefold() in UK_NATIONS), parts[-2] if len(parts) >= 2 else "")
    return county, region


def build_record(source: str, tab: str, row_no: int, row: list[object],
                 cols: dict[str, int]) -> Address | None:
    """One row -> one Address, or None when the row is entirely blank."""
    if not any(_text(c) for c in row):
        return None
    address = row_address(row, cols)
    parsed = parse_address(address, source)
    county, region = target_parts(_text(row[cols["target"]]) if cols["target"] != -1
                                  and cols["target"] < len(row) else "")
    record = Address(
        source=source, tab=tab, row=row_no, address=address,
        city=parsed["city"], county=county,
        state_code=parsed["state_code"], state_name=parsed["state_name"] or region,
        postcode=parsed["postcode"], postcode_district=parsed["postcode_district"],
        country=parsed["country"],
        school=_text(row[cols["school"]]) if cols["school"] != -1 and cols["school"] < len(row) else "",
        website=_text(row[cols["website"]]) if cols["website"] != -1 and cols["website"] < len(row) else "",
        facebook=_text(row[cols["facebook"]]) if cols["facebook"] != -1 and cols["facebook"] < len(row) else "",
        phone=_text(row[cols["phone"]]) if cols["phone"] != -1 and cols["phone"] < len(row) else "",
        category=_text(row[cols["category"]]) if cols["category"] != -1 and cols["category"] < len(row) else "",
        notes=list(parsed["notes"]),
    )
    if not address:
        record.reason = "row has no address"
    elif not record.city:
        record.reason = "address has no city"
    return record


# ── talking to Google ────────────────────────────────────────────────────────


class SheetsUnavailable(RuntimeError):
    """The workbooks could not be read; a cached snapshot may still serve."""


def _session():
    """A requests session authorised by the service account, or None."""
    try:
        import google.auth.transport.requests as gt
        from google.oauth2 import service_account
        import requests
    except ImportError as err:  # pragma: no cover - depends on the install
        raise SheetsUnavailable(f"Google client libraries are missing: {err}") from err
    from .config import REPO_ROOT

    key = Path(__import__("os").environ.get("GOOGLE_APPLICATION_CREDENTIALS")
               or (REPO_ROOT / "gcp-creds.json"))
    if not key.is_file():
        raise SheetsUnavailable(f"no service-account key at {key}")
    creds = service_account.Credentials.from_service_account_file(str(key), scopes=SCOPES)
    creds.refresh(gt.Request())
    session = requests.Session()
    session.headers["Authorization"] = f"Bearer {creds.token}"
    return session


def _get(session, url: str, params: dict[str, object] | None = None) -> dict:
    res = session.get(url, params=params, timeout=60)
    if not res.ok:
        raise SheetsUnavailable(f"Google Sheets returned {res.status_code}: "
                                f"{(res.text or '').strip()[:200]}")
    return res.json()


def list_tabs(session, spreadsheet_id: str) -> list[str]:
    body = _get(session, f"{SHEETS_API}/{spreadsheet_id}",
                {"fields": "sheets.properties.title"})
    return [s["properties"]["title"] for s in body.get("sheets", [])]


def read_tab(session, spreadsheet_id: str, tabs: list[str]) -> list[list[list[object]]]:
    """Values for each tab, in the order asked. One batchGet per 20 tabs."""
    body = _get(session, f"{SHEETS_API}/{spreadsheet_id}/values:batchGet",
                {"ranges": tabs, "valueRenderOption": "FORMATTED_VALUE"})
    ranges = body.get("valueRanges", [])
    return [r.get("values", []) for r in ranges]


def fetch_all(use_cache: bool = True) -> list[Address]:
    """Every address from both workbooks, cached for a week."""
    if use_cache and CACHE_FILE.is_file():
        age = time.time() - CACHE_FILE.stat().st_mtime
        if age < CACHE_TTL_S:
            log.info("Using the address snapshot from %s (%.0f h old).",
                     CACHE_FILE.name, age / 3600)
            return load(CACHE_FILE)
    session = _session()
    records: list[Address] = []
    for source, sheet_id in WORKBOOKS.items():
        tabs = list_tabs(session, sheet_id)
        log.info("%s: %d tab(s).", source, len(tabs))
        for i in range(0, len(tabs), CHUNK_TABS):
            chunk = tabs[i: i + CHUNK_TABS]
            for tab, values in zip(chunk, read_tab(session, sheet_id, chunk)):
                if not values:
                    continue
                cols = columns(values[0])
                if cols["address"] == -1 and cols["city"] == -1:
                    log.warning("%s / %s: no address column (headers: %s); skipped.",
                                source, tab, values[0][:8])
                    continue
                for offset, row in enumerate(values[1:], start=2):
                    record = build_record(source, tab, offset, row, cols)
                    if record is not None:
                        records.append(record)
    save(records, CACHE_FILE)
    return records


def save(records: list[Address], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"fetched_at": time.time(), "workbooks": WORKBOOKS,
               "addresses": [asdict(r) for r in records]}
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def load(path: Path) -> list[Address]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return [Address(**row) for row in payload["addresses"]]


def summarise(records: list[Address]) -> dict[str, object]:
    """Counts for the CLI, and the audit the vocab builder checks."""
    usable = [r for r in records if r.usable]
    by_source: dict[str, dict[str, int]] = {}
    for record in records:
        bucket = by_source.setdefault(record.source, {"rows": 0, "usable": 0})
        bucket["rows"] += 1
        bucket["usable"] += int(record.usable)
    reasons: dict[str, int] = {}
    for record in records:
        if record.reason:
            reasons[record.reason] = reasons.get(record.reason, 0) + 1
    return {
        "rows": len(records),
        "usable": len(usable),
        "by_source": by_source,
        "reasons": reasons,
        "countries": {c: sum(1 for r in usable if r.country == c)
                      for c in sorted({r.country for r in usable})},
        "unique_cities": len({(r.country, r.city.casefold()) for r in usable if r.city}),
        "unique_counties": len({r.county.casefold() for r in usable if r.county}),
        "unique_postcode_districts": len({r.postcode_district for r in usable if r.postcode_district}),
    }


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        prog="fb_addresses",
        description="List every address in U.S. Conquest and The Official UK.")
    parser.add_argument("--refresh", action="store_true",
                        help="read the workbooks again even if the snapshot is fresh")
    parser.add_argument("--out", default=str(CACHE_FILE), help="where to write the snapshot")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    records = fetch_all(use_cache=not args.refresh)
    summary = summarise(records)
    print(json.dumps(summary, indent=2))
    if not records:
        print("No addresses found.", file=__import__("sys").stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
