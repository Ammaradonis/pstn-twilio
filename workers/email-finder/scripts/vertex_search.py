"""Standalone Vertex AI Search query script.

Sends a search query to the GCP Vertex AI Search (Discovery Engine) data store
and prints the top results as JSON.

Usage (from the workers/email-finder directory):
  .venv\Scripts\python scripts\vertex_search.py "Sidewinder Jiu Jitsu Sherman email"

Credentials are loaded from GOOGLE_APPLICATION_CREDENTIALS (set automatically
by config.py to gcp-creds.json when the env var is absent).

GCP project : local-gmail-510114
Data store  : sotftphone_1790865491347
Location    : global
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Bootstrap environment — reads .env and env.txt, sets GOOGLE_APPLICATION_CREDENTIALS.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.config import load_settings  # noqa: E402  (path must be set first)

settings = load_settings()

_project = settings.vertex_project or "local-gmail-510114"
_data_store = settings.vertex_data_store or "sotftphone_1790865491347"
_location = settings.vertex_location or "global"


def search(query: str, page_size: int = 10) -> list[dict]:
    """Run a Vertex AI Search query and return a list of result dicts.

    Each dict has: url, title, snippet.
    Returns an empty list if the package is unavailable or the query fails.
    """
    try:
        from google.cloud import discoveryengine  # type: ignore[import]
    except ImportError:
        print("[vertex_search] google-cloud-discoveryengine not installed. "
              "Run: .venv\\Scripts\\pip install google-cloud-discoveryengine", file=sys.stderr)
        return []

    serving_config = (
        f"projects/{_project}/locations/{_location}"
        f"/collections/default_collection/dataStores/{_data_store}"
        f"/servingConfigs/default_config"
    )
    client = discoveryengine.SearchServiceClient()
    request = discoveryengine.SearchRequest(
        serving_config=serving_config,
        query=query[:500],
        page_size=page_size,
    )
    try:
        response = client.search(request)
    except Exception as exc:
        print(f"[vertex_search] Query failed: {exc}", file=sys.stderr)
        return []

    results = []
    for r in response.results:
        doc = r.document.derived_struct_data
        title = doc.get("title", "")
        link = doc.get("link", "")
        snippets = doc.get("snippets", []) or []
        snippet = " ".join(s.get("snippet", "") for s in snippets[:3]) if snippets else ""
        if link:
            results.append({"url": link, "title": title, "snippet": snippet})
    return results


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: vertex_search.py <query>", file=sys.stderr)
        sys.exit(1)

    query = " ".join(sys.argv[1:])
    print(f"[vertex_search] Querying: {query!r}", file=sys.stderr)
    print(f"  project={_project}  data_store={_data_store}  location={_location}", file=sys.stderr)

    results = search(query)
    if not results:
        print("[vertex_search] No results.", file=sys.stderr)
    else:
        print(json.dumps(results, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
