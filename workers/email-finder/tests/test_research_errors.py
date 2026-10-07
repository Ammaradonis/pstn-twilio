"""The three errors the Dial page showed under "Research needs attention"
(October 2026): running out of memory, the per-row time limit, and paid web
search being unavailable. Offline: no network, no browser."""

from __future__ import annotations

import asyncio
import random
import string
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from email_finder import nlp  # noqa: E402
from email_finder.engine import Engine, Row, _Job  # noqa: E402
from email_finder.google_free import GoogleBlocked  # noqa: E402
from email_finder.search import Result, SearchUnavailable  # noqa: E402
from email_finder.worker import to_result  # noqa: E402

LEASE = "00000000-0000-4000-8000-000000000000"
ROW = dict(title="Tiger Dojo", address="1 Main St, Austin, TX 78701", phone="+1 512 921 4950")
SITE_ROW = dict(ROW, website="https://tigerdojo.com")
HIT = Result("https://www.martialartsguide.org/schools/tiger-dojo", "Tiger Dojo - Austin, TX",
             "Tiger Dojo in Austin. Contact the owner: owner@tigerdojo.com", provider="google-web")
PAID_DOWN = ("Web search unavailable (Google Custom Search API disabled or not permitted for this key; "
             "Brave credit exhausted, top up at api-dashboard.search.brave.com); will retry.")


class _Fetcher:
    use_browser = False

    async def get(self, url):
        return None

    async def render(self, url):
        return None


class _SiteFetcher(_Fetcher):
    """The school's homepage loads, with no address on it."""

    async def get(self, url):
        if url.rstrip("/") == "https://tigerdojo.com":
            return SimpleNamespace(blocked=False, final_url="https://tigerdojo.com/", via="",
                                   html="<h1>Tiger Dojo</h1><p>Karate for kids and adults in Austin.</p>")
        return None


class _Domains:
    async def accepts_mail(self, domain):
        return True


class _PaidDown:
    """Google API 403 and Brave 402, as on the Dial page."""
    enabled = True

    def __init__(self):
        self.queries = []

    async def search(self, q, country="US"):
        self.queries.append(q)
        raise SearchUnavailable(PAID_DOWN)


class _Google:
    enabled = True

    def __init__(self, results=(), blocked=False, hang_after=None):
        self.results, self.blocked, self.hang_after = list(results), blocked, hang_after
        self.queries = []

    async def search(self, q, country="US"):
        self.queries.append(q)
        if self.blocked:
            raise GoogleBlocked("daily free-search limit reached")
        if self.hang_after is not None and len(self.queries) > self.hang_after:
            await asyncio.sleep(3600)  # a page load that never finishes
        return self.results

    async def business_profile(self, q, country="US"):
        return None


def _engine(google, search, mode="bare"):
    return Engine(_SiteFetcher(), search, _Domains(), google=google, google_mode=mode)  # type: ignore[arg-type]


# ── "Unable to allocate 1.06 MiB for an array with shape (2907, 96)" ─────────


def _junk(words: int) -> str:
    return " ".join("".join(random.choices(string.ascii_letters + string.digits, k=12)) for _ in range(words))


def test_reading_pages_does_not_grow_the_vocabulary():
    """Each page's new words used to stay in spaCy's vocabulary for the life of
    the worker, until the PC had no memory left for even a 1 MB array."""
    model = nlp.nlp()
    nlp.people("warm up: Sensei John Smith is the owner.")
    before = len(model.vocab.strings)
    for _ in range(5):
        found = nlp.people("Sensei John Smith is the owner and head instructor. " + _junk(2000))
        assert found[0].name == "John Smith" and found[0].role == "owner"
    assert len(model.vocab.strings) == before


def test_running_out_of_memory_retries_the_row_and_restarts_the_worker(monkeypatch):
    async def out_of_memory(self):
        raise MemoryError("Unable to allocate 1.06 MiB for an array with shape (2907, 96) and data type float32")
    monkeypatch.setattr(_Job, "_run", out_of_memory)
    engine = _engine(_Google(), _PaidDown())
    finding = asyncio.run(engine.find(Row(**ROW)))
    result = to_result("r1", finding, LEASE)
    assert result["status"] == "RETRY" and result["researchComplete"] is False
    assert not result["notes"].startswith("error:")  # not a permanent failure
    assert engine.out_of_memory  # the worker restarts to get its memory back


# ── "Research time limit reached; will resume using cached pages" ────────────


def test_a_row_that_runs_out_of_time_keeps_the_address_it_found():
    """The address found before the limit used to be thrown away with the rest
    of the row, which then started over, and could time out again forever."""
    google = _Google([HIT], hang_after=1)
    finding = asyncio.run(_engine(google, _PaidDown()).find(Row(**ROW), timeout=0.5))
    assert finding.timed_out
    assert finding.email == "owner@tigerdojo.com"
    assert to_result("r1", finding, LEASE)["status"] == "FOUND"


def test_a_row_that_runs_out_of_time_with_nothing_is_retried_then_closed():
    google = _Google([], hang_after=0)
    finding = asyncio.run(_engine(google, _PaidDown()).find(Row(**ROW), timeout=0.3))
    result = to_result("r1", finding, LEASE)
    assert finding.timed_out and result["status"] == "RETRY" and result["retryAfter"] == 1800
    assert "Research time limit reached" in result["notes"]

    # Its last try closes it instead of scheduling another.
    google = _Google([], hang_after=0)
    finding = asyncio.run(_engine(google, _PaidDown()).find(Row(**ROW), timeout=0.3, last_try=True))
    result = to_result("r1", finding, LEASE)
    assert result["status"] == "NOT_FOUND" and result["researchComplete"] is True
    assert "retryAfter" not in result


# ── "Web search unavailable (Google … disabled …; Brave credit exhausted …)" ──


def test_free_google_researches_a_row_while_paid_search_is_down():
    """A row with a website never got the free Google pass, so with the Google
    API disabled and Brave out of credit it waited two hours, again and again."""
    google, paid = _Google([HIT]), _PaidDown()
    finding = asyncio.run(_engine(google, paid).find(Row(**SITE_ROW)))
    assert paid.queries and google.queries
    assert finding.email == "owner@tigerdojo.com"
    assert to_result("r1", finding, LEASE)["status"] == "FOUND"


def test_free_google_saying_none_finishes_the_row_while_paid_search_is_down():
    finding = asyncio.run(_engine(_Google([]), _PaidDown()).find(Row(**SITE_ROW)))
    result = to_result("r1", finding, LEASE)
    assert result["status"] == "NOT_FOUND" and result["researchComplete"] is True


def test_the_row_waits_for_paid_search_when_free_google_cannot_help_either():
    for google, mode in ((_Google(blocked=True), "bare"), (_Google([HIT]), "off")):
        finding = asyncio.run(_engine(google, _PaidDown(), mode).find(Row(**SITE_ROW)))
        result = to_result("r1", finding, LEASE)
        assert result["status"] == "RETRY" and result["retryAfter"] == 7200
        assert "Brave credit exhausted" in result["notes"]
