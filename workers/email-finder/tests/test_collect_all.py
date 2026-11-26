"""Collect mode: every address a school publishes, not just the first good one."""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from email_finder.android import Galaxy  # noqa: E402
from email_finder.cache import Cache  # noqa: E402
from email_finder.config import load_settings  # noqa: E402
from email_finder.engine import Engine, Row, _Job  # noqa: E402
from email_finder.fetch import Page  # noqa: E402


class _Stub:
    enabled = False


HOME = """<html><body><h1>Tiger Dojo</h1>
<a href="/contact">Contact</a> <a href="/about">About</a> <a href="/staff">Staff</a>
<p>Tiger Dojo has taught karate in Springfield since 1998. """ + "Classes for kids and adults. " * 20 + """</p>
</body></html>"""


class _Site:
    """Serves a small school site and records which pages were read."""

    use_browser = False

    def __init__(self) -> None:
        self.visited: list[str] = []

    async def get(self, url: str):
        self.visited.append(url)
        path = url.split("tigerdojo.test", 1)[-1] or "/"
        pages = {
            "/": HOME,
            "/contact": "<p>Owner John Smith: john@tigerdojo.test</p>",
            "/about": "<p>Front desk: info@tigerdojo.test</p>",
            "/staff": "<p>Kids program: kids@tigerdojo.test</p>",
        }
        html = pages.get(path.rstrip("/") or "/")
        return Page(url=url, status=200, html=html, final_url=url) if html else None

    async def render(self, url: str):
        return None


def _crawl(collect: str) -> _Site:
    site = _Site()
    engine = Engine(fetcher=site, search=_Stub(), domains=None, collect=collect)  # type: ignore[arg-type]
    job = _Job(engine, Row(title="Tiger Dojo", website="https://tigerdojo.test/"))
    # As soon as one owner address is on file, "first" mode has what it came for.
    job._has_strong_owner_email = lambda: True  # type: ignore[method-assign]
    asyncio.run(job._crawl_site("https://tigerdojo.test/"))
    return site


def test_collect_all_reads_every_contact_page():
    pages = [u for u in _crawl("all").visited if u != "https://tigerdojo.test/"]
    assert {"https://tigerdojo.test/contact", "https://tigerdojo.test/about", "https://tigerdojo.test/staff"} <= set(pages)


def test_first_mode_stops_at_the_first_owner_address():
    pages = [u for u in _crawl("first").visited if u != "https://tigerdojo.test/"]
    assert len(pages) == 1


@pytest.mark.parametrize(("mode", "collect_all"), [("all", True), ("paid", True), ("first", False)])
def test_collect_all_flag(mode, collect_all):
    engine = Engine(fetcher=None, search=_Stub(), domains=None, collect=mode)  # type: ignore[arg-type]
    assert engine.collect_all is collect_all


@pytest.mark.parametrize(("value", "expected"), [(None, "all"), ("PAID", "paid"), ("first", "first"), ("most", "all")])
def test_collect_setting(monkeypatch, value, expected):
    if value is None:
        monkeypatch.delenv("EMAIL_FINDER_COLLECT", raising=False)
    else:
        monkeypatch.setenv("EMAIL_FINDER_COLLECT", value)
    assert load_settings().collect == expected


def test_extra_phone_lookups_keep_40_percent_for_rows_with_nothing(tmp_path):
    phone = Galaxy(Cache(tmp_path / "c.db"), "adb", lock_path=tmp_path / "galaxy.lock", daily_limit=10)
    for _ in range(5):
        assert phone.cache.reserve("galaxy", 10)
    assert phone.has_spare()
    assert phone.cache.reserve("galaxy", 10)
    # 6 of 10 used: the last 4 are kept for schools with no address yet.
    assert not phone.has_spare()
