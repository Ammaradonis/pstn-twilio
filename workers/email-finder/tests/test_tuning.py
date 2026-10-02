import importlib.util
import itertools
import json
from dataclasses import asdict
from pathlib import Path
import socket
import sys

import pytest

WORKER = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WORKER))
sys.path.insert(0, str(WORKER / "scripts"))
from email_finder.engine import Row
from email_finder.scoring import ScoreWeights, load_weights
from tune import GRID, grouped_splits, identity_keys, prepare, predict


def record(identity="a", website="https://tigerdojo.org", phone="+12025550123"):
    return {"id": identity, "row": asdict(Row(title="Tiger Dojo", website=website, phone=phone)),
            "persons": [{"name": "John Smith", "role": "owner", "weight": 1.0}],
            "site_host": "tigerdojo.org", "site_domain": "tigerdojo.org", "site_is_schools": True,
            "own_domains": ["tigerdojo.org"], "dns": {"tigerdojo.org": True, "gmail.com": True},
            "candidates": [{"email": email, "source": "mailto", "url": website + path,
                            "context": "Tiger Dojo contact " + email}
                           for email in ("john.smith@tigerdojo.org", "info@tigerdojo.org", "tigerdojo@gmail.com")
                           for path in ("/contact", "/about")]}


def test_offline_replay_cannot_use_network(monkeypatch):
    def fail(*args, **kwargs):
        raise AssertionError("Offline tuning attempted a connection")
    monkeypatch.setattr(socket, "socket", fail)
    monkeypatch.setattr(socket, "getaddrinfo", fail)
    item = prepare(record())
    assert len(item["candidates"]) == 3
    assert predict(item, ScoreWeights())[1]["email"] == "john.smith@tigerdojo.org"
    assert all(c["supported"] for c in item["candidates"])


def test_replay_scores_match_production_for_entire_grid():
    from email_finder.engine import Engine, _Job
    from email_finder.extract import Candidate
    from email_finder.nlp import Person
    from types import SimpleNamespace
    raw = record()
    item = prepare(raw)
    engine = Engine(None, SimpleNamespace(enabled=False), None, scoring=ScoreWeights())
    job = _Job(engine, Row(**raw["row"]))
    job.site_host, job.site_domain, job.site_is_schools = "tigerdojo.org", "tigerdojo.org", True
    people = [Person(**p) for p in raw["persons"]]
    job._persons_cache = people
    for values in itertools.product(*GRID.values()):
        weights = ScoreWeights(**dict(zip(GRID, values)))
        engine.scoring = weights
        direct = [job._score(c["email"], [Candidate(**e) for e in raw["candidates"] if e["email"] == c["email"]], people, True)
                  for c in item["candidates"]]
        best = max(direct, key=lambda c: c.score)
        score, chosen = predict(item, weights)
        assert (score, chosen["email"], chosen["kind"]) == (best.score, best.email, best.kind)


def test_dns_unknown_is_never_treated_as_success():
    raw = record()
    raw["dns"] = {"tigerdojo.org": None, "gmail.com": False}
    assert not prepare(raw)["candidates"]


def test_transitive_phone_and_domain_groups_never_leak():
    rows = [record("a", "https://one.org", "+12025550123"),
            record("b", "https://two.org", "2025550123"),
            record("c", "https://two.org/other", "+12025550124"),
            record("d", "https://three.org", "+12025550124")]
    splits = grouped_splits(rows, 17)
    assert len(set(splits.values())) == 1
    assert grouped_splits(list(reversed(rows)), 17) == splits


def test_bad_weights_fall_back_to_safe_defaults(tmp_path):
    path = tmp_path / "weights.json"
    path.write_text(json.dumps({"version": 1, "weights": {"minimum_score": 10}}))
    assert load_weights(path) == ScoreWeights()
    with pytest.raises(ValueError):
        ScoreWeights(decision_bonus=True)


def test_phone_dedup_handles_legacy_headers_and_preserves_distinct_numbers():
    spec = importlib.util.spec_from_file_location("dedup", WORKER.parent.parent / "scripts/dedup_us_conquest.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    rows = [["name", "websiteUrl", "address", "number"],
            ["A", "", "", "+1 (903) 515-5700"], ["B", "", "", "9035155700"],
            ["C", "", "", ""], ["D", "", "", ""],
            ["E", "", "", "+44 20 7946 0123"], ["F", "", "", "+1 207 946 0123"]]
    audit = module.audit(rows)
    assert audit["duplicate_rows"] == [2]
    assert audit["blank_phones"] == 2
    for request in module.deletion_requests(5, audit["duplicate_rows"]):
        span = request["deleteDimension"]["range"]
        del rows[span["startIndex"]:span["endIndex"]]
    assert not module.audit(rows)["duplicate_rows"]


def test_concurrent_rows_share_one_page_download(tmp_path):
    import asyncio
    from email_finder.cache import Cache
    from email_finder.fetch import Fetcher, Page
    async def run():
        fetcher = Fetcher(Cache(tmp_path / "cache.sqlite"), per_host_delay=0, use_browser=False)
        calls = []
        async def allowed(url):
            return True
        async def download(url):
            calls.append(url)
            await asyncio.sleep(.01)
            return Page(url, 200, "<p>school</p>", url)
        fetcher.allowed, fetcher._download = allowed, download
        try:
            pages = await asyncio.gather(*(fetcher.get("https://dojo.org") for _ in range(10)))
            assert len(calls) == 1
            assert all(page.html == "<p>school</p>" for page in pages)
        finally:
            await fetcher.close()
    asyncio.run(run())
