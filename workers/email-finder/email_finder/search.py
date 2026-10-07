"""Search provider chain: Brave / BEAVE → Vertex AI Search (only when configured).

Provider priority (cheapest / most reliable first):
  1. Brave Search API / BEAVE_API_KEY (Brave spelling alias) — 300/day each.
  2. Vertex AI Search (Google Cloud Discovery Engine) — only when a project and
     an app or data store are configured; unlimited per GCP quota and billed per
     query, so it stays last. Off unless VERTEX_AI_PROJECT is set.

The Google Custom Search JSON API was removed from this chain: this project has
no access to it (HTTP 403 "This project does not have the access to Custom
Search JSON API"), and Google closed the API to new customers. It therefore
never answered a query here and only cost one refused request per lookup. The
Programmable Search Engine itself is untouched: google_free.py reads its public
results page for free (see the CSE path there).

BEAVE is a spelling of Brave, not a separate service. All credentials are sent
only to the documented API endpoints.
"""
from __future__ import annotations
import asyncio
import hashlib
import json
import logging
import re
import time
from dataclasses import dataclass, field
import httpx
from .cache import Cache

log = logging.getLogger(__name__)
SEARCH_TTL = 7 * 24 * 3600

@dataclass
class Result:
    url: str
    title: str
    snippet: str
    extra: list[str] = field(default_factory=list)
    # Which search found it: brave, vertex, google-web, google-cse or
    # google-business-profile (the free paths in google_free.py).
    provider: str = ""

    @property
    def text(self) -> str:
        return " ".join([self.title, self.snippet, *self.extra])

class SearchBudgetExhausted(Exception):
    pass

class SearchUnavailable(Exception):
    pass


# ── Vertex AI Search helper ───────────────────────────────────────────────────

class _VertexSearch:
    """Thin async wrapper around google-cloud-discoveryengine.

    Lazy-imports the client so the worker still starts if the package is absent.
    The service account is loaded from GOOGLE_APPLICATION_CREDENTIALS (set via
    the gcp-creds.json path).
    """

    def __init__(self, project_id: str, data_store_id: str, location: str = "global") -> None:
        self.project_id = project_id
        self.data_store_id = data_store_id
        self.location = location
        self._client = None
        self._available: bool | None = None  # None = not yet checked

    def _ensure(self) -> bool:
        if self._available is not None:
            return self._available
        try:
            from google.cloud import discoveryengine  # type: ignore[import]
            self._client = discoveryengine.SearchServiceClient()
            serving = (
                f"projects/{self.project_id}/locations/{self.location}"
                f"/collections/default_collection/dataStores/{self.data_store_id}"
                f"/servingConfigs/default_config"
            )
            self._serving = serving
            self._SearchRequest = discoveryengine.SearchRequest
            self._available = True
            log.info("Vertex AI Search provider ready (data store: %s)", self.data_store_id)
        except Exception as exc:
            log.info("Vertex AI Search unavailable (%s); using other providers only.", exc)
            self._available = False
        return self._available

    async def search(self, query: str, count: int = 10) -> list[Result]:
        if not self._ensure():
            return []
        try:
            req = self._SearchRequest(serving_config=self._serving, query=query[:500], page_size=count)
            # Run the synchronous gRPC call in a thread to avoid blocking the event loop.
            response = await asyncio.to_thread(self._client.search, req)
            results: list[Result] = []
            for r in response.results:
                doc = r.document.derived_struct_data
                title = doc.get("title", "")
                link = doc.get("link", "")
                snippets = doc.get("snippets", []) or []
                snippet = " ".join(s.get("snippet", "") for s in snippets[:3]) if snippets else ""
                if link:
                    results.append(Result(url=link, title=_strip(title), snippet=_strip(snippet),
                                          provider="vertex"))
            return results
        except Exception as exc:
            log.warning("Vertex AI Search query failed: %s", exc)
            return []


# ── Main search class ─────────────────────────────────────────────────────────

class BraveSearch:
    """Compatibility name for the multi-provider search chain.

    Provider order (first that has quota and is not disabled wins):
      1. brave   — Brave Search API (BRAVE_API_KEY or BEAVE_API_KEY alias)
      2. vertex  — Vertex AI Search (only when a project and an app or data
                   store are configured; GCP billing applies)
    """

    def __init__(self, api_key: str | None, cache: Cache, daily_limit: int,
                 beave_api_key: str | None = None, beave_daily_limit: int = 300,
                 vertex_project: str | None = None, vertex_data_store: str | None = None,
                 vertex_location: str = "global", extra_brave_keys: tuple[str, ...] = ()) -> None:
        self.cache = cache
        # Each entry: (provider_name, credential_or_None, daily_limit)
        # For vertex the "credential" field is unused (uses ADC); None is fine.
        self.providers: list[tuple[str, str | None, int]] = []

        # 1. Brave / BEAVE: every distinct key, each with its own credit and
        #    daily budget; a key that runs out (402) is skipped for an hour.
        seen: set[str] = set()
        keys = ((beave_api_key, beave_daily_limit), (api_key, daily_limit),
                *((k, beave_daily_limit) for k in extra_brave_keys))
        for key, limit in keys:
            if key and key not in seen:
                self.providers.append(("brave", key, limit))
                seen.add(key)

        # 2. Vertex AI Search (unlimited, billed per query; only when configured)
        self._vertex: _VertexSearch | None = None
        if vertex_project and vertex_data_store:
            self._vertex = _VertexSearch(vertex_project, vertex_data_store, vertex_location)
            self.providers.append(("vertex", None, 99999))

        self._lock = asyncio.Lock()
        self._last = 0.0
        self._disabled: dict[str, float] = {}
        # provider → why it last failed, shown on the Dial page via row notes.
        self._why: dict[str, str] = {}
        self._client = httpx.AsyncClient(timeout=20.0)

    @classmethod
    def from_settings(cls, settings, cache: Cache):
        return cls(
            settings.brave_api_key, cache, settings.brave_daily_limit,
            settings.beave_api_key, settings.beave_daily_limit,
            vertex_project=getattr(settings, "vertex_project", None),
            vertex_data_store=getattr(settings, "vertex_data_store", None),
            vertex_location=getattr(settings, "vertex_location", "global"),
            extra_brave_keys=getattr(settings, "brave_keys", ()),
        )

    @classmethod
    def from_env(cls, cache: Cache):
        """Convenience factory that reads directly from environment (for standalone scripts)."""
        from .config import load_settings
        return cls.from_settings(load_settings(), cache)

    @property
    def enabled(self) -> bool:
        return bool(self.providers)

    async def close(self) -> None:
        await self._client.aclose()

    async def search(self, query: str, country: str = "US", count: int = 10) -> list[Result]:
        count = min(10, max(1, count))
        query = query[:600]
        cache_key = f"{country}|{count}|{query}"
        async with self._lock:
            cached = self.cache.get("search-v2", cache_key)
            if cached is not None:
                return [Result(**r) for r in cached]
            all_exhausted = bool(self.providers)
            for provider, credential, limit in self.providers:
                # Vertex uses a dedicated async path
                if provider == "vertex" and self._vertex is not None:
                    results = await self._vertex.search(query, count)
                    if results:
                        self.cache.set("search-v2", cache_key, [r.__dict__ for r in results], SEARCH_TTL)
                        return results
                    continue

                counter = provider + ":" + hashlib.sha256((credential or "").encode()).hexdigest()[:12]
                if self.cache.count(counter) >= limit:
                    continue
                all_exhausted = False
                if self._disabled.get(counter, 0) > time.monotonic():
                    continue
                for attempt in range(2):
                    wait = self._last + 1.1 - time.monotonic()
                    if wait > 0:
                        await asyncio.sleep(wait)
                    if not self.cache.reserve(counter, limit):
                        break
                    self._last = time.monotonic()
                    try:
                        res = await self._request(credential, query, country, count)
                    except httpx.HTTPError:
                        log.warning("%s search network failure", provider)
                        self._disabled[counter] = time.monotonic() + 60
                        break
                    if res.status_code == 200:
                        try:
                            data = res.json()
                            items = data.get("web", {}).get("results", [])
                            results = [Result(
                                url=r.get("url", ""),
                                title=_strip(r.get("title", "")),
                                snippet=_strip(r.get("description", "")),
                                extra=[_strip(s) for s in r.get("extra_snippets", []) or []],
                                provider=provider,
                            ) for r in items]
                        except (ValueError, TypeError, AttributeError):
                            log.warning("%s returned an invalid search response", provider)
                            break
                        self.cache.set("search-v2", cache_key, [r.__dict__ for r in results], SEARCH_TTL)
                        return results
                    log.warning("%s search HTTP %s; trying fallback", provider, res.status_code)
                    self._why[provider] = _failure_reason(provider, res)
                    if res.status_code == 429 and attempt == 0:
                        await asyncio.sleep(3)
                        continue
                    # 402 is Brave's CREDIT_EXHAUSTED: nothing changes until the account is topped up.
                    self._disabled[counter] = time.monotonic() + (3600 if res.status_code in (400, 401, 402, 403) else 60)
                    break
            if all_exhausted:
                raise SearchBudgetExhausted("Daily search allowance reached; work will resume later.")
            if self.enabled:
                why = "; ".join(self._why.values())
                raise SearchUnavailable(
                    f"Web search unavailable ({why}); will retry." if why
                    else "Configured search services are temporarily unavailable."
                )
            return []

    async def _request(self, credential: str | None, query: str, country: str, count: int):
        return await self._client.get("https://api.search.brave.com/res/v1/web/search", params={
            "q": query, "count": count, "country": country, "search_lang": "en",
            "extra_snippets": "true", "safesearch": "moderate",
        }, headers={"Accept": "application/json", "X-Subscription-Token": credential or ""})

def _strip(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text or "")


def _failure_reason(provider: str, res: httpx.Response) -> str:
    """Short, key-free reason a provider refused a query."""
    try:
        err = res.json().get("error") or {}
    except ValueError:
        err = {}
    if provider == "brave" and res.status_code == 402:
        return "Brave credit exhausted, top up at api-dashboard.search.brave.com"
    code = err.get("code") or err.get("status") or res.status_code
    return f"{provider.title()} HTTP {code}"
