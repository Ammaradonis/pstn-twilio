#!/usr/bin/env python3
"""Create and configure a Vertex AI Search (Discovery Engine) data store
for the martial arts email finder.

This script:
  1. Authenticates using the service account at GOOGLE_APPLICATION_CREDENTIALS
     (automatically set by config.py to gcp-creds.json when the env var is absent).
  2. Creates (or confirms existence of) a Vertex AI Search data store in the
     global location under the project.
  3. Creates a search engine (serving config) attached to the data store.
  4. Runs a smoke-test query to confirm everything is working.
  5. Prints the VERTEX_AI_DATA_STORE_ID you should add to .env / env.txt.

Usage:
  cd workers/email-finder
  .venv\\Scripts\\python scripts\\create_vertex_datastore.py

Prerequisites:
  pip install google-cloud-discoveryengine google-auth

IAM roles needed on the service account:
  - roles/discoveryengine.admin   (to create data stores and engines)
  - roles/discoveryengine.viewer  (to run search queries)

The script is idempotent — re-running it against an existing data store is safe.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

# Bootstrap — sets GOOGLE_APPLICATION_CREDENTIALS from gcp-creds.json when absent.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder.config import load_settings  # noqa: E402

settings = load_settings()

# ── Configuration ─────────────────────────────────────────────────────────────

PROJECT_ID: str = settings.vertex_project or "local-gmail-510114"
LOCATION: str = settings.vertex_location or "global"

# The data store ID is the stable identifier used everywhere in the engine.
# Keep it short, alphanumeric + hyphens, <= 63 chars.
DATA_STORE_ID: str = (
    settings.vertex_data_store
    or os.environ.get("VERTEX_AI_DATA_STORE_ID")
    or "martial-arts-email-finder"
)

# Human-readable display name shown in the GCP console.
DATA_STORE_DISPLAY: str = "Martial Arts Email Finder"
ENGINE_ID: str = DATA_STORE_ID + "-engine"
ENGINE_DISPLAY: str = DATA_STORE_DISPLAY + " Engine"

# Industry vertical: GENERIC for web search / document retrieval.
VERTICAL = "GENERIC"

# Web crawl URI patterns: tell Vertex to index these public martial arts
# directories so they are searchable without going through Google CSE quota.
SEED_URIS: list[str] = [
    # Martial arts directories
    "https://www.usadojo.com/*",
    "https://www.bestmartialartsschools.com/*",
    "https://www.martialartsteachers.com/*",
    "https://www.themartialartsdirectory.com/*",
    "https://www.usamartialartists.org/*",
    "https://dojos.info/*",
    # US federations
    "https://www.usmaf.org/*",
    "https://www.usawkf.org/*",
    "https://www.ibjjf.com/*",
    "https://www.worldtaekwondo.org/*",
    "https://www.atamartialarts.com/*",
    # UK federations
    "https://www.bmaba.org.uk/*",
    "https://www.britishmartialarts.co.uk/*",
    "https://www.britishtaekwondo.org.uk/*",
    # Business directories (martial arts category pages)
    "https://www.yelp.com/search?find_desc=Martial+Arts*",
    "https://www.yell.com/s/martial+arts*",
]


# ── Helpers ───────────────────────────────────────────────────────────────────

def _log(msg: str) -> None:
    print(f"[create_vertex_datastore] {msg}", flush=True)


def _die(msg: str) -> None:
    print(f"[create_vertex_datastore] ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


def _check_imports() -> tuple:
    """Import and return the required GCP clients."""
    try:
        from google.cloud import discoveryengine_v1 as de  # type: ignore[import]
    except ImportError:
        _die(
            "google-cloud-discoveryengine is not installed.\n"
            "Run:  .venv\\Scripts\\pip install google-cloud-discoveryengine google-auth"
        )
    try:
        import google.auth  # type: ignore[import]
        import google.auth.exceptions  # type: ignore[import]
        creds, project = google.auth.default()
        _log(f"Authenticated. Detected project from ADC: {project!r}")
    except Exception as exc:
        _die(
            f"Authentication failed: {exc}\n"
            "Make sure GOOGLE_APPLICATION_CREDENTIALS points to gcp-creds.json, or run:\n"
            "  $env:GOOGLE_APPLICATION_CREDENTIALS = 'C:\\...\\gcp-creds.json'"
        )
    return de


def _parent(de) -> str:
    return f"projects/{PROJECT_ID}/locations/{LOCATION}"


def _collection(de) -> str:
    return f"{_parent(de)}/collections/default_collection"


# ── Data store ────────────────────────────────────────────────────────────────

def ensure_data_store(de) -> str:
    """Create the data store if it does not exist; return its full resource name."""
    client = de.DataStoreServiceClient()
    full_name = f"{_collection(de)}/dataStores/{DATA_STORE_ID}"

    # Check if already exists.
    try:
        store = client.get_data_store(name=full_name)
        _log(f"Data store already exists: {store.name}")
        return store.name
    except Exception:
        pass  # Does not exist yet — create it.

    _log(f"Creating data store '{DATA_STORE_ID}' in project '{PROJECT_ID}'…")
    request = de.CreateDataStoreRequest(
        parent=_collection(de),
        data_store_id=DATA_STORE_ID,
        data_store=de.DataStore(
            display_name=DATA_STORE_DISPLAY,
            # GENERIC vertical supports web crawl + document indexing.
            industry_vertical=de.IndustryVertical.GENERIC,
            # Enable advanced document understanding for better snippet extraction.
            document_processing_config=de.DocumentProcessingConfig(
                default_parsing_config=de.DocumentProcessingConfig.ParsingConfig(
                    digital_parsing_config=de.DocumentProcessingConfig.ParsingConfig.DigitalParsingConfig()
                )
            ),
        ),
    )
    try:
        operation = client.create_data_store(request=request)
        _log("Waiting for data store creation to complete…")
        result = operation.result(timeout=300)
        _log(f"Data store created: {result.name}")
        return result.name
    except Exception as exc:
        _die(f"Failed to create data store: {exc}")


# ── Site search spec (web crawl configuration) ────────────────────────────────

def configure_site_search(de, data_store_name: str) -> None:
    """Add the martial arts directory seed URIs so Vertex crawls them."""
    client = de.SiteSearchEngineServiceClient()
    engine_resource = data_store_name + "/siteSearchEngine"

    _log(f"Configuring {len(SEED_URIS)} seed URIs for web crawl…")
    for uri in SEED_URIS:
        try:
            op = client.create_target_site(
                request=de.CreateTargetSiteRequest(
                    parent=engine_resource,
                    target_site=de.TargetSite(
                        provided_uri_pattern=uri,
                        type_=de.TargetSite.Type.INCLUDE,
                        exact_match=False,
                    ),
                )
            )
            # Don't block on crawl completion — just queue it.
            _log(f"  Queued crawl: {uri}")
        except Exception as exc:
            # URIs that already exist or are invalid will error; that's fine.
            _log(f"  Skip {uri}: {exc}")


# ── Search engine ─────────────────────────────────────────────────────────────

def ensure_engine(de) -> str:
    """Create a search engine attached to the data store; return its name."""
    client = de.EngineServiceClient()
    parent = _parent(de)
    full_name = f"{parent}/engines/{ENGINE_ID}"

    try:
        engine = client.get_engine(name=full_name)
        _log(f"Search engine already exists: {engine.name}")
        return engine.name
    except Exception:
        pass

    _log(f"Creating search engine '{ENGINE_ID}'…")
    try:
        op = client.create_engine(
            request=de.CreateEngineRequest(
                parent=parent,
                engine_id=ENGINE_ID,
                engine=de.Engine(
                    display_name=ENGINE_DISPLAY,
                    solution_type=de.SolutionType.SOLUTION_TYPE_SEARCH,
                    industry_vertical=de.IndustryVertical.GENERIC,
                    data_store_ids=[DATA_STORE_ID],
                    search_engine_config=de.Engine.SearchEngineConfig(
                        search_tier=de.SearchTier.SEARCH_TIER_STANDARD,
                    ),
                ),
            )
        )
        result = op.result(timeout=300)
        _log(f"Search engine created: {result.name}")
        return result.name
    except Exception as exc:
        _die(f"Failed to create search engine: {exc}")


# ── Smoke test ────────────────────────────────────────────────────────────────

def smoke_test(de) -> None:
    """Run a test query and print the first result."""
    _log("Running smoke-test query: 'Arnold's Martial Arts Sherman Texas email'…")
    client = de.SearchServiceClient()
    serving_config = (
        f"projects/{PROJECT_ID}/locations/{LOCATION}"
        f"/collections/default_collection/dataStores/{DATA_STORE_ID}"
        f"/servingConfigs/default_config"
    )
    try:
        request = de.SearchRequest(
            serving_config=serving_config,
            query="Arnold's Martial Arts Sherman Texas email",
            page_size=3,
        )
        # Give the data store a few seconds if it was just created.
        time.sleep(3)
        response = client.search(request)
        results = list(response.results)
        if not results:
            _log("Smoke test: no results yet (data store may still be indexing — try again in a few minutes).")
            return
        _log(f"Smoke test: {len(results)} result(s).")
        for i, r in enumerate(results, 1):
            doc = r.document.derived_struct_data
            title = doc.get("title", "(no title)")
            link = doc.get("link", "(no link)")
            _log(f"  [{i}] {title} — {link}")
    except Exception as exc:
        _log(f"Smoke test failed (may need a few minutes for the data store to become ready): {exc}")


# ── Summary ───────────────────────────────────────────────────────────────────

def print_env_vars() -> None:
    print()
    print("=" * 64)
    print("ADD THESE TO YOUR .env / env.txt (if not already set):")
    print("=" * 64)
    print(f"GOOGLE_CLOUD_PROJECT={PROJECT_ID}")
    print(f"VERTEX_AI_PROJECT={PROJECT_ID}")
    print(f"VERTEX_AI_DATA_STORE_ID={DATA_STORE_ID}")
    print(f"VERTEX_AI_LOCATION={LOCATION}")
    print()
    print("The email finder worker reads these automatically from env.txt.")
    print("=" * 64)


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    _log(f"Project: {PROJECT_ID}   Location: {LOCATION}   Data store: {DATA_STORE_ID}")

    de = _check_imports()

    ds_name = ensure_data_store(de)
    configure_site_search(de, ds_name)
    ensure_engine(de)
    smoke_test(de)
    print_env_vars()

    _log("Done. The data store is being indexed; full results may take 24–48 hours.")


if __name__ == "__main__":
    main()
