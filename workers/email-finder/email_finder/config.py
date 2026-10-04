"""Local configuration. Never log credential values."""
from __future__ import annotations
import os
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from dotenv import dotenv_values

WORKER_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = WORKER_DIR.parent.parent
CACHE_DIR = WORKER_DIR / ".cache"

# Process > .env > env.txt. Only parse assignments; never execute this notes file.
logging.getLogger("dotenv.main").setLevel(logging.ERROR)
for _env_path in (REPO_ROOT / ".env", REPO_ROOT / "env.txt"):
    for _key, _value in dotenv_values(_env_path).items():
        if _value:
            os.environ.setdefault(_key, _value)

# ── GCP credentials ──────────────────────────────────────────────────────────
# Point Application Default Credentials at the service account JSON if the env
# var is not already set (e.g. from a shell profile or Windows task).
_gcp_json = REPO_ROOT / "gcp-creds.json"
if _gcp_json.exists() and not os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
    os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = str(_gcp_json)

def _numbered_keys(*prefixes: str) -> tuple[str, ...]:
    """Values of NAME, NAME2, NAME3, ... for each prefix, in that order, without
    duplicates. env.txt holds BEAVE_API_KEY through BEAVE_API_KEY6, each with its
    own Brave credit."""
    found: list[tuple[int, int, str]] = []
    for name, value in os.environ.items():
        for rank, prefix in enumerate(prefixes):
            m = re.fullmatch(re.escape(prefix) + r"(\d*)", name)
            if m and value.strip():
                found.append((rank, int(m.group(1) or 1), value.strip()))
    return tuple(dict.fromkeys(v for _, _, v in sorted(found)))

def _int(name: str, default: int) -> int:
    try:
        return max(0, int(os.environ.get(name, "") or default))
    except ValueError:
        return default

@dataclass(frozen=True)
class Settings:
    api_base: str
    worker_token: str | None
    brave_api_key: str | None
    brave_daily_limit: int
    beave_api_key: str | None
    beave_daily_limit: int
    concurrency: int
    per_host_delay: float
    max_site_pages: int
    use_browser: bool
    chrome_profile_path: str | None
    google_api_key: str | None = None
    google_cx: str | None = None
    google_daily_limit: int = 100
    # Every Brave key found (BEAVE_API_KEY, BEAVE_API_KEY2, ... then BRAVE_API_KEY...).
    brave_keys: tuple[str, ...] = ()
    browser_cdp_url: str | None = None
    row_timeout: int = 900
    # Free Google search in a browser (google_free.py): "bare" runs it before
    # Brave for rows with no website or social profile, "all" for every row.
    google_free: str = "bare"
    google_free_daily_limit: int = 150
    # cookies.txt export whose google.com cookies sign the search browser in.
    google_cookies: Path | None = None
    # Vertex AI Search — unlimited fallback (GCP billing applies)
    vertex_project: str | None = None
    vertex_data_store: str | None = None
    vertex_location: str = "global"

def load_settings() -> Settings:
    try:
        delay = max(0.5, float(os.environ.get("EMAIL_FINDER_PER_HOST_DELAY", "1.5")))
    except ValueError:
        delay = 1.5

    # Google CSE — accept both env-var spellings used in env.txt
    google_api_key = (
        os.environ.get("GOOGLE_SEARCH_API_KEY")
        or os.environ.get("GOOGLE_CLOUD_API_KEY")
        or None
    )
    google_cx = (
        os.environ.get("GOOGLE_SEARCH_CX")
        or os.environ.get("GOOGLE_CSE_ID")
        or os.environ.get("GOOGLE_SEARCH_ENGINE_ID")  # env.txt spelling
        or None
    )

    # Vertex AI Search — project + data-store ID
    vertex_project = (
        os.environ.get("VERTEX_AI_PROJECT")
        or os.environ.get("GOOGLE_CLOUD_PROJECT")
        or "local-gmail-510114"  # from env.txt "Project ID: local-gmail-510114"
    )
    vertex_data_store = (
        os.environ.get("VERTEX_AI_DATA_STORE_ID")
        or os.environ.get("Vertex_AI_Search_APP_ID")  # env.txt key
        or "sotftphone_1790865491347"  # from env.txt Vertex_AI_Search_APP_ID
    )
    vertex_location = os.environ.get("VERTEX_AI_LOCATION") or "global"
    google_free = (os.environ.get("EMAIL_FINDER_GOOGLE_FREE") or "bare").strip().lower()
    cookies = (os.environ.get("EMAIL_FINDER_GOOGLE_COOKIES") or "").strip()
    google_cookies = None
    if cookies.lower() not in ("off", "none", "0"):
        candidate = Path(cookies) if cookies else REPO_ROOT / "cookies.txt"
        google_cookies = candidate if candidate.is_file() else None

    return Settings(
        api_base=(os.environ.get("EMAIL_FINDER_API_BASE") or os.environ.get("PUBLIC_BASE_URL")
                  or "https://api.bestsoftphone.site").rstrip("/"),
        worker_token=os.environ.get("EMAIL_FINDER_WORKER_TOKEN") or None,
        brave_api_key=os.environ.get("BRAVE_API_KEY") or None,
        brave_daily_limit=_int("EMAIL_FINDER_BRAVE_DAILY_LIMIT", 300),
        beave_api_key=os.environ.get("BEAVE_API_KEY") or None,
        beave_daily_limit=_int("EMAIL_FINDER_BEAVE_DAILY_LIMIT", 300),
        concurrency=min(4, max(1, _int("EMAIL_FINDER_CONCURRENCY", 2))),
        per_host_delay=delay,
        max_site_pages=max(4, _int("EMAIL_FINDER_MAX_SITE_PAGES", 10)),
        use_browser=os.environ.get("EMAIL_FINDER_USE_BROWSER", "1") != "0",
        # Never automatically launch against the user's locked, default Chrome profile.
        chrome_profile_path=os.environ.get("EMAIL_FINDER_CHROME_PROFILE_PATH") or None,
        google_api_key=google_api_key,
        google_cx=google_cx,
        google_daily_limit=_int("EMAIL_FINDER_GOOGLE_DAILY_LIMIT", 100),
        brave_keys=_numbered_keys("BEAVE_API_KEY", "BRAVE_API_KEY"),
        browser_cdp_url=os.environ.get("EMAIL_FINDER_BROWSER_CDP_URL") or None,
        row_timeout=min(1000, max(60, _int("EMAIL_FINDER_ROW_TIMEOUT", 900))),
        google_free=google_free if google_free in ("bare", "all", "off") else "bare",
        google_free_daily_limit=_int("EMAIL_FINDER_GOOGLE_FREE_DAILY_LIMIT", 150),
        google_cookies=google_cookies,
        vertex_project=vertex_project,
        vertex_data_store=vertex_data_store,
        vertex_location=vertex_location,
    )
