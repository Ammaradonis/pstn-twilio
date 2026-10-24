"""Upload verified school↔ad matches to the API.

The pipeline's fourth worker keeps `self.results` keyed by
(spreadsheetId, sheetId, row, adId). This module turns the verified ones into
the API's evidence shape and posts them with the shared worker token, so the
Dial page's "Meta ad filter" button can build its new tab from any machine.

Nothing here decides what counts as a match: that is the pipeline's job. A row
is only exported when the advertiser name and the Facebook page both verified.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterable, Iterator

import httpx

from matching import ad_dates

ROOT = Path(__file__).resolve().parents[2]
# Keep well under the API's 1000-observation limit.
MAX_BATCH = 200

# Load the repo's .env the way workers/email-finder does, without importing its
# whole settings object (this module is also used by tests and `--sync-only`).
# env.txt carries prose, so keep dotenv's parse warnings out of the worker log.
try:
    import logging

    from dotenv import dotenv_values

    logging.getLogger('dotenv.main').setLevel(logging.ERROR)
    for _path in (ROOT / '.env', ROOT / 'env.txt'):
        if _path.is_file():
            for _key, _value in dotenv_values(_path).items():
                if _value:
                    os.environ.setdefault(_key, _value)
except ImportError:  # pragma: no cover - dotenv is part of the worker venv
    pass

STATUS = {'Active': 'ACTIVE', 'Inactive': 'INACTIVE'}


def api_base() -> str:
    return (
        os.environ.get('META_ADS_API_BASE')
        or os.environ.get('EMAIL_FINDER_API_BASE')
        or os.environ.get('PUBLIC_BASE_URL')
        or 'https://api.bestsoftphone.site'
    ).rstrip('/')


def worker_token() -> str | None:
    token = (os.environ.get('EMAIL_FINDER_WORKER_TOKEN') or '').strip()
    return token or None


def observation(result: dict) -> dict | None:
    """One API observation from one pipeline result, or None if it cannot be one."""
    if not result.get('evidence'):
        return None
    lead, ad = result.get('lead') or {}, result.get('ad') or {}
    status = STATUS.get(ad.get('status', ''))
    ad_id = str(ad.get('adId') or '')
    required = (lead.get('spreadsheetId'), lead.get('sheetTitle'), lead.get('title'),
                ad.get('name'), ad.get('facebookUrl'), ad.get('observedAt'))
    if not status or not ad_id.isdigit() or not all(required):
        return None
    dates = ad_dates(ad)
    return {
        'spreadsheetId': lead['spreadsheetId'],
        'sheetId': int(lead['sheetId']),
        'sheetTitle': lead['sheetTitle'],
        'rowIndex': int(lead['row']),
        'schoolTitle': lead['title'],
        # A name-only match has no page cell to send. The advertiser's page goes
        # here so an API older than this worker (it required a URL) still takes
        # the batch; `matchKind` below is what says the match was by name.
        'facebookUrl': lead['facebookUrl'] or ad['facebookUrl'],
        'advertiserName': ad['name'],
        'advertiserUrl': ad['facebookUrl'],
        'adId': ad_id,
        'status': status,
        # Meta prints a start day for every ad and an end day once it stops.
        'startedAt': dates[0].isoformat() if dates else None,
        'endedAt': dates[1].isoformat() if dates and status == 'INACTIVE' else None,
        'observedAt': ad['observedAt'],
        # 'page': the tab's own facebookUrl cell is the ad's page.
        # 'name': the tab has no page URL, so the exact school name is what
        # matched; the filter tab shows the advertiser's page alongside it.
        'matchKind': 'page' if result.get('urlMatch') else 'name',
    }


def evidence_rows(results: Iterable[dict]) -> list[dict]:
    rows = [row for row in (observation(r) for r in results) if row]
    # The same ad must not be sent twice for the same school.
    unique: dict[tuple, dict] = {}
    for row in rows:
        unique[(row['spreadsheetId'], row['sheetId'], row['adId'], row['schoolTitle'])] = row
    return list(unique.values())


def batches(rows: list[dict], size: int = MAX_BATCH) -> Iterator[list[dict]]:
    for start in range(0, len(rows), size):
        yield rows[start : start + size]


def by_tab(rows: list[dict], size: int = MAX_BATCH) -> Iterator[list[dict]]:
    """Batches of one tab's observations: a tab the API rejects costs only itself.

    The API validated Google's sheet ids against a 2,000,000,000 ceiling, which
    is below the real int32 range: a batch holding a tab above it (Massachusetts
    at 2,079,617,744) was rejected whole, so none of the other tabs in it reached
    the button either. One tab per request keeps that failure local.
    """
    tabs: dict[tuple, list[dict]] = {}
    for row in rows:
        tabs.setdefault((row['spreadsheetId'], row['sheetId']), []).append(row)
    for chunk in tabs.values():
        yield from batches(chunk, size)


async def upload(
    rows: list[dict],
    *,
    token: str | None = None,
    base: str | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict:
    """POST the observations, one tab per batch; raise with the API's first refusal."""
    if not rows:
        return {'saved': 0, 'tabs': 0}
    token = token or worker_token()
    if not token:
        raise RuntimeError('EMAIL_FINDER_WORKER_TOKEN is not set, so matches cannot reach the app.')
    saved, tabs = 0, 0
    rejected: list[str] = []
    async with httpx.AsyncClient(
        base_url=f'{(base or api_base()).rstrip("/")}/api/meta-ads/worker',
        headers={'x-worker-token': token},
        timeout=60,
        transport=transport,
    ) as client:
        for chunk in by_tab(rows):
            response = await client.post('evidence', json={'observations': chunk})
            if response.status_code >= 400:
                # Keep going: the other tabs are still worth storing, and the
                # refusal is reported once at the end (status.json + sync.log).
                rejected.append(
                    f'{chunk[0]["sheetTitle"]}: {response.status_code} {response.text[:200]}'
                )
                continue
            try:
                body = response.json() or {}
            except ValueError:  # a proxy's HTML page, not our API
                body = {}
            saved += int(body.get('saved') or 0)
            tabs = max(tabs, int(body.get('tabs') or 0))
    if rejected:
        raise RuntimeError(
            f'evidence upload failed for {len(rejected)} tab(s), {saved} row(s) saved; '
            f'first refusal: {rejected[0]}'
        )
    return {'saved': saved, 'tabs': tabs}
