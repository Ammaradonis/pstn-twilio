"""Brave Search API: find schools' sites, profiles and listings, and read snippets.

Results are cached for 30 days, requests are throttled, and a daily ceiling
stops runaway spend (each query is billed).
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field

import httpx

from .cache import Cache

log = logging.getLogger(__name__)
SEARCH_TTL = 30 * 24 * 3600


@dataclass
class Result:
    url: str
    title: str
    snippet: str
    extra: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return " ".join([self.title, self.snippet, *self.extra])


class SearchBudgetExhausted(Exception):
    pass


class BraveSearch:
    def __init__(self, api_key: str | None, cache: Cache, daily_limit: int) -> None:
        self.api_key = api_key
        self.cache = cache
        self.daily_limit = daily_limit
        self._lock = asyncio.Lock()
        self._last = 0.0
        self._client = httpx.AsyncClient(timeout=20.0)

    @property
    def enabled(self) -> bool:
        return bool(self.api_key)

    async def close(self) -> None:
        await self._client.aclose()

    async def search(self, query: str, country: str = "US", count: int = 10) -> list[Result]:
        key = f"{country}|{count}|{query}"
        cached = self.cache.get("brave", key)
        if cached is not None:
            return [Result(**r) for r in cached]
        if not self.enabled:
            return []
        if self.cache.count("brave") >= self.daily_limit:
            raise SearchBudgetExhausted()
        async with self._lock:  # ~2 queries/second, well under the plan's limit
            wait = self._last + 0.5 - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self._last = time.monotonic()
            results = await self._request(query, country, count)
        if results is not None:
            self.cache.bump("brave")
            self.cache.set("brave", key, [r.__dict__ for r in results], SEARCH_TTL)
        return results or []

    async def _request(self, query: str, country: str, count: int) -> list[Result] | None:
        params = {
            "q": query,
            "count": count,
            "country": "GB" if country == "GB" else "US",
            "search_lang": "en",
            "extra_snippets": "true",
            "safesearch": "moderate",
        }
        for attempt in range(3):
            try:
                res = await self._client.get(
                    "https://api.search.brave.com/res/v1/web/search",
                    params=params,
                    headers={"Accept": "application/json", "X-Subscription-Token": self.api_key or ""},
                )
            except httpx.HTTPError as err:
                log.warning("Brave search error: %s", err)
                await asyncio.sleep(2 * (attempt + 1))
                continue
            if res.status_code == 429:
                await asyncio.sleep(2 * (attempt + 1))
                continue
            if res.status_code != 200:
                log.warning("Brave search HTTP %s for %r", res.status_code, query)
                return None
            web = res.json().get("web", {}).get("results", [])
            return [
                Result(
                    url=r.get("url", ""),
                    title=_strip(r.get("title", "")),
                    snippet=_strip(r.get("description", "")),
                    extra=[_strip(s) for s in r.get("extra_snippets", []) or []],
                )
                for r in web
            ]
        return None


def _strip(text: str) -> str:
    import re

    return re.sub(r"<[^>]+>", "", text or "")
