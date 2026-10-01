"""Settings for the email finder worker, read from the repo's root .env."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

WORKER_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = WORKER_DIR.parent.parent
CACHE_DIR = WORKER_DIR / ".cache"

load_dotenv(REPO_ROOT / ".env")


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    api_base: str
    worker_token: str | None
    brave_api_key: str | None
    # Rows worked on at the same time. Each row is mostly waiting on the network.
    concurrency: int
    # Hard ceiling on paid Brave queries per day (they cost money).
    brave_daily_limit: int
    # Seconds between requests to the same host.
    per_host_delay: float
    # Pages fetched per school website.
    max_site_pages: int
    # Headless Chrome for JavaScript-only pages; off on low-memory machines.
    use_browser: bool


def load_settings() -> Settings:
    api = (
        os.environ.get("EMAIL_FINDER_API_BASE")
        or os.environ.get("PUBLIC_BASE_URL")
        or "https://api.bestsoftphone.site"
    )
    return Settings(
        api_base=api.rstrip("/"),
        worker_token=os.environ.get("EMAIL_FINDER_WORKER_TOKEN") or None,
        brave_api_key=os.environ.get("BRAVE_API_KEY") or None,
        concurrency=max(1, _int("EMAIL_FINDER_CONCURRENCY", 3)),
        brave_daily_limit=_int("EMAIL_FINDER_BRAVE_DAILY_LIMIT", 3000),
        per_host_delay=float(os.environ.get("EMAIL_FINDER_PER_HOST_DELAY", "1.5")),
        max_site_pages=_int("EMAIL_FINDER_MAX_SITE_PAGES", 8),
        use_browser=os.environ.get("EMAIL_FINDER_USE_BROWSER", "1") != "0",
    )
