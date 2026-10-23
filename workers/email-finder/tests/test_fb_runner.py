"""The runner the Dial page's button drives: stage by stage, without a phone.

`FacebookGroups` is replaced by a recorder, the plan by a two-term file, and the
API by a stub, so what is tested here is only the pipeline logic: which stage
does what, when it advances, and what it reports.
"""

import asyncio
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import email_finder.fb_runner as runner_module
from email_finder.fb_engage import FbLimits
from email_finder.fb_groups import GroupRecord, GroupStore, GroupVisit
from email_finder.fb_runner import Batch, FbGroupsRunner
from email_finder.fb_vocab import GroupCandidate, term_key


class FakeCache:
    def __init__(self) -> None:
        self.kv: dict[tuple[str, str], object] = {}
        self.counters: dict[str, int] = {}

    def get(self, ns: str, key: str):
        return self.kv.get((ns, key))

    def set(self, ns: str, key: str, value, ttl: float) -> None:
        self.kv[(ns, key)] = value

    def count(self, name: str) -> int:
        return self.counters.get(name, 0)

    def reserve(self, name: str, limit: int) -> bool:
        used = self.counters.get(name, 0)
        if limit > 0 and used >= limit:
            return False
        self.counters[name] = used + 1
        return True

    def delete(self, ns: str, key: str) -> None:
        self.kv.pop((ns, key), None)


class FakePhone:
    def __init__(self) -> None:
        self.cache = FakeCache()


class FakeGroups:
    """Records what the runner asked for and keeps the store's contract.

    The real driver marks a search as run and persists a joined group; a fake
    that skipped those two writes would make the runner's stage logic look wrong
    when it is the fake that is lying.
    """

    def __init__(self, store: GroupStore) -> None:
        self.store = store
        self.searches: list[str] = []
        self.joined: list[str] = []
        self.visited: list[str] = []
        self.outreached: list[str] = []

    async def search(self, term):
        self.searches.append(term.term)
        self.store.mark_searched(term_key(term.term, term.country), 1, 1)
        return [GroupCandidate(name="Martial Arts School Owners (Testville)",
                               url="https://facebook.com/groups/1", score=88,
                               kind="owners", members=12_000, found_by=term.term)]

    async def join(self, candidate, country: str = "", covers: int = 0):
        self.joined.append(candidate.name)
        record = GroupRecord(name=candidate.name, url=candidate.url, state="joined",
                             score=candidate.score, kind=candidate.kind, joined_at=1.0)
        self.store.put(record)
        return record

    async def visit(self, group, per_group: int = 6):
        self.visited.append(group.name)
        return GroupVisit(group=group.name, likes=3, comments=1, replies=1, follows=1)

    async def outreach(self, group, max_dms: int = 3):
        self.outreached.append(group.name)
        return [("Coach Dan", "you wrote: ...")]


class FakeRemote:
    def __init__(self, reply: dict | None = None, fail: Exception | None = None) -> None:
        self.reply = reply
        self.fail = fail
        self.sent: list[dict] = []

    async def tick(self) -> dict:
        if self.fail:
            raise self.fail
        return self.reply or {}

    async def progress(self, body: dict) -> None:
        self.sent.append(body)

    async def close(self) -> None:
        pass


PLAN = {
    "terms": [
        {"term": "testville martial arts", "bucket": "martial-arts", "tier": 1,
         "country": "US", "place_key": "us:testville", "covers": 4, "sources": []},
        {"term": "testville business owners", "bucket": "owners", "tier": 1,
         "country": "US", "place_key": "us:testville", "covers": 4, "sources": []},
    ],
    "national": [],
    "places": {},
    "ledger": {},
}


def limits(**overrides) -> FbLimits:
    base = dict(quiet_hours=None, account_age_days=90)
    base.update(overrides)
    return FbLimits(**base)


def make(tmp_path: Path, monkeypatch, reply: dict | None, **limit_overrides):
    plan_file = tmp_path / "plan.json"
    plan_file.write_text(json.dumps(PLAN), encoding="utf-8")
    monkeypatch.setattr(runner_module, "PLAN_FILE", plan_file)
    remote = FakeRemote(reply)
    runner = FbGroupsRunner(FakePhone(), remote, limits=limits(**limit_overrides))
    groups = FakeGroups(runner.store)
    runner.groups = groups
    return runner, remote, groups


def run(stage: str, batch: dict | None = None) -> dict:
    return {"run": {"id": "11111111-1111-1111-1111-111111111111", "status": "RUNNING",
                    "stage": stage}, "batch": batch or {}}


# ── the tick ─────────────────────────────────────────────────────────────────


def test_no_run_means_no_work(tmp_path, monkeypatch):
    runner, remote, groups = make(tmp_path, monkeypatch, {"run": None, "batch": None})

    async def go():
        return await runner.run_once()

    assert asyncio.run(go()) is None
    assert remote.sent == [] and groups.searches == []


def test_a_run_posts_its_progress(tmp_path, monkeypatch):
    runner, remote, _ = make(tmp_path, monkeypatch,
                             run("SEARCH", {"searches": 1, "joins": 0, "engagements": 0, "dms": 0}))

    async def go():
        return await runner.run_once()

    asyncio.run(go())
    assert len(remote.sent) == 1
    assert remote.sent[0]["runId"].startswith("1111")
    assert remote.sent[0]["searches"] == 1


# ── the stages ───────────────────────────────────────────────────────────────


def test_search_runs_the_next_searches_and_finds_groups(tmp_path, monkeypatch):
    runner, _, groups = make(tmp_path, monkeypatch, None)
    result = asyncio.run(runner.step(run("SEARCH")["run"],
                                     {"searches": 1, "joins": 0, "engagements": 0, "dms": 0}))
    assert groups.searches == ["testville martial arts"]
    assert result.searches == 1
    assert result.groupsFound == 1
    assert result.stage == "JOIN"  # rotate while discovery still has work
    assert "1 search(es)" in result.note


def test_capped_search_does_not_starve_joining(tmp_path, monkeypatch):
    runner, _, groups = make(tmp_path, monkeypatch, None)

    async def capped(term):
        return []

    groups.search = capped
    result = asyncio.run(runner.step(run("SEARCH")["run"], {"searches": 1}))
    assert result.searches == 0
    assert result.stage == "JOIN"
    assert runner.next_searches(1)  # the skipped address remains queued


def test_capped_join_does_not_starve_engagement(tmp_path, monkeypatch):
    runner, _, groups = make(tmp_path, monkeypatch, None)
    record = GroupRecord(name="Martial Arts School Owners", score=88, state="candidate", members=500)
    runner.store.put(record)

    async def capped(candidate, **kwargs):
        return record

    groups.join = capped
    result = asyncio.run(runner.step(run("JOIN")["run"], {"joins": 1}))
    assert result.joined == 0
    assert result.stage == "ENGAGE"
    assert runner.store.get(record.name).state == "candidate"


def test_search_advances_to_join_when_the_plan_is_exhausted(tmp_path, monkeypatch):
    runner, _, groups = make(tmp_path, monkeypatch, None)
    asyncio.run(runner.step(run("SEARCH")["run"], {"searches": 5}))
    assert groups.searches == ["testville martial arts", "testville business owners"]
    result = asyncio.run(runner.step(run("SEARCH")["run"], {"searches": 5}))
    assert result.stage == "JOIN"
    assert "every search" in result.note


def test_join_takes_the_best_candidates_then_advances(tmp_path, monkeypatch):
    runner, _, groups = make(tmp_path, monkeypatch, None)
    runner.store.put(GroupRecord(name="Martial Arts School Owners (Testville)",
                                 url="https://facebook.com/groups/1", score=88,
                                 state="candidate", kind="owners"))
    result = asyncio.run(runner.step(run("JOIN")["run"], {"joins": 2}))
    assert groups.joined == ["Martial Arts School Owners (Testville)"]
    assert result.joined == 1
    assert result.stage == "ENGAGE"


def test_join_leaves_low_scoring_candidates_alone(tmp_path, monkeypatch):
    runner, _, groups = make(tmp_path, monkeypatch, None)
    runner.store.put(GroupRecord(name="Testville Buy Sell", score=12, state="candidate"))
    result = asyncio.run(runner.step(run("JOIN")["run"], {"joins": 2}))
    assert groups.joined == []
    assert result.stage == "ENGAGE"


@pytest.mark.parametrize("stage,key", [("JOIN", "joins"), ("ENGAGE", "engagements"), ("OUTREACH", "dms")])
def test_zero_budget_never_performs_an_action(tmp_path, monkeypatch, stage, key):
    runner, _, groups = make(tmp_path, monkeypatch, None)
    runner.store.put(GroupRecord(name="candidate", url="https://facebook.com/groups/1", score=90))
    runner.store.put(GroupRecord(name="joined", state="joined"))
    result = asyncio.run(runner.step(run(stage)["run"], {key: 0}))
    assert groups.joined == groups.visited == groups.outreached == []
    assert result.stage == stage and "no " in result.note


def test_quiet_hours_stop_before_any_stage_touches_phone(tmp_path, monkeypatch):
    runner, _, groups = make(tmp_path, monkeypatch, None)
    monkeypatch.setattr("email_finder.ambient.in_quiet_hours", lambda *args: True)
    result = asyncio.run(runner.step(run("SEARCH")["run"], {"searches": 3}))
    assert groups.searches == []
    assert result.note.startswith("quiet hours")


def test_recent_visit_does_not_remove_group_from_outreach(tmp_path, monkeypatch):
    import time
    runner, _, groups = make(tmp_path, monkeypatch, None)
    runner.store.put(GroupRecord(name="recent", state="joined", last_visit=time.time()))
    result = asyncio.run(runner.step(run("OUTREACH")["run"], {"dms": 1}))
    assert groups.outreached == ["recent"] and result.dms == 1


def test_blocked_visit_reason_survives_in_report(tmp_path, monkeypatch):
    runner, _, groups = make(tmp_path, monkeypatch, None)
    runner.store.put(GroupRecord(name="joined", state="joined"))

    async def unavailable(group):
        return GroupVisit(group=group.name, blocked="phone unavailable")

    groups.visit = unavailable
    result = asyncio.run(runner.step(run("ENGAGE")["run"], {"engagements": 1}))
    assert "phone unavailable" in result.note


def test_cached_plan_summary_counts_actual_addresses(tmp_path, monkeypatch):
    from types import SimpleNamespace
    runner, _, _ = make(tmp_path, monkeypatch, None)
    runner._plan = {"terms": [{}, {}], "ledger": {"one": ["query"], "two": ["other"]}}
    snapshot = tmp_path / "addresses.json"
    snapshot.write_text("[]")
    monkeypatch.setattr(runner_module, "CACHE_FILE", snapshot)
    monkeypatch.setattr(runner_module, "load", lambda path: [
        SimpleNamespace(address="one", usable=True), SimpleNamespace(address="one", usable=True),
        SimpleNamespace(address="two", usable=True), SimpleNamespace(address="", usable=False)])
    summary = runner.plan_summary()
    assert summary["addresses"] == summary["covered"] == 3
    assert summary["uncovered"] == 0


def test_engage_visits_a_due_group_and_moves_to_outreach(tmp_path, monkeypatch):
    runner, _, groups = make(tmp_path, monkeypatch, None)
    runner.store.put(GroupRecord(name="Martial Arts School Owners (Testville)",
                                 url="https://facebook.com/groups/1", state="joined",
                                 last_visit=0))
    result = asyncio.run(runner.step(run("ENGAGE")["run"], {"engagements": 1}))
    assert groups.visited == ["Martial Arts School Owners (Testville)"]
    assert (result.likes, result.comments, result.replies, result.follows) == (3, 1, 1, 1)
    assert result.stage == "OUTREACH"


def test_outreach_sends_dms_and_starts_the_cycle_again(tmp_path, monkeypatch):
    runner, _, groups = make(tmp_path, monkeypatch, None)
    runner.store.put(GroupRecord(name="Group A", url="https://facebook.com/groups/1",
                                 state="joined", last_visit=0))
    result = asyncio.run(runner.step(run("OUTREACH")["run"], {"dms": 2}))
    assert groups.outreached == ["Group A"]
    assert result.dms == 1
    assert result.stage == "SEARCH"


def test_an_unknown_stage_starts_again_from_search(tmp_path, monkeypatch):
    runner, _, _ = make(tmp_path, monkeypatch, None)
    result = asyncio.run(runner.step({"stage": "SPAMMING", "id": "x"}, {}))
    assert result.stage == "SEARCH"


def test_the_engagement_switch_stops_the_pipeline_and_says_so(tmp_path, monkeypatch):
    runner, _, groups = make(tmp_path, monkeypatch, None, enabled=False)
    result = asyncio.run(runner.step(run("SEARCH")["run"], {"searches": 3}))
    assert groups.searches == []
    assert "switched off" in result.note


def test_the_plan_is_reported_once(tmp_path, monkeypatch):
    runner, _, _ = make(tmp_path, monkeypatch, None)
    first = asyncio.run(runner.step(run("SEARCH")["run"], {"searches": 1}))
    second = asyncio.run(runner.step(run("SEARCH")["run"], {"searches": 1}))
    # The file has no counts of its own, so the summary is the term count.
    assert first.plan is not None
    assert second.plan is None


# ── the payload ──────────────────────────────────────────────────────────────


def test_only_non_zero_counters_are_sent():
    batch = Batch(stage="ENGAGE", likes=4, comments=0, note="4 like(s)")
    body = batch.payload("run-1")
    assert body == {"runId": "run-1", "stage": "ENGAGE", "note": "4 like(s)", "likes": 4}


def test_a_long_note_is_cut_to_the_api_limit():
    body = Batch(note="x" * 900).payload("run-1")
    assert len(body["note"]) == 500


def test_the_plan_rides_along_when_it_is_known():
    batch = Batch(stage="SEARCH", note="1 search")
    batch.plan = {"addresses": 27_965, "covered": 27_965, "searches": 49_083,
                  "uncovered": 0, "builtAt": "2026-10-22T13:00:00Z"}
    assert batch.payload("run-1")["plan"]["covered"] == 27_965


# ── the loop ─────────────────────────────────────────────────────────────────


def test_the_loop_stops_when_asked(tmp_path, monkeypatch):
    runner, remote, _ = make(tmp_path, monkeypatch, {"run": None, "batch": None})
    monkeypatch.setattr(runner_module, "IDLE_SECONDS", 0.01)
    stop = asyncio.Event()

    async def go():
        task = asyncio.create_task(runner.loop(stop))
        await asyncio.sleep(0.05)
        stop.set()
        await asyncio.wait_for(task, timeout=2)

    asyncio.run(go())
    assert stop.is_set()


def test_the_loop_survives_a_failed_tick(tmp_path, monkeypatch):
    import httpx

    runner, remote, _ = make(tmp_path, monkeypatch, None)
    remote.fail = httpx.ConnectError("no API")
    monkeypatch.setattr(runner_module, "IDLE_SECONDS", 0.01)
    stop = asyncio.Event()

    async def go():
        task = asyncio.create_task(runner.loop(stop))
        await asyncio.sleep(0.05)
        stop.set()
        await asyncio.wait_for(task, timeout=2)

    asyncio.run(go())  # a dead API must not take the worker down with it
    assert stop.is_set()


# ── the wire contract ────────────────────────────────────────────────────────


def test_the_worker_calls_the_endpoints_the_api_serves():
    """A route or header mismatch is the failure a unit test can actually catch.

    The API's worker controller lives at `/api/fb-groups/worker` with `tick` and
    `progress`, guarded by `x-worker-token`. This drives a real HTTP stub and
    asserts those three facts plus the body shape, so a rename on either side
    fails here instead of silently doing nothing on the user's PC.
    """
    import http.server
    import json
    import threading

    from email_finder.fb_runner import FbRemote

    calls: list[dict] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 - the base class names it
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            calls.append({
                "path": self.path,
                "token": self.headers.get("x-worker-token"),
                "body": json.loads(raw or b"{}"),
            })
            payload = {"run": {"id": "run-1", "status": "RUNNING", "stage": "SEARCH"},
                       "batch": {"searches": 3, "joins": 0, "engagements": 0, "dms": 0}}
            data = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"

    async def go():
        remote = FbRemote(base, "secret-token")
        tick = await remote.tick()
        await remote.progress({"runId": "run-1", "stage": "SEARCH", "searches": 2,
                               "note": "2 search(es)"})
        await remote.close()
        return tick

    try:
        tick = asyncio.run(go())
    finally:
        server.shutdown()

    assert tick["batch"]["searches"] == 3
    assert [call["path"] for call in calls] == ["/api/fb-groups/worker/tick",
                                                "/api/fb-groups/worker/progress"]
    assert all(call["token"] == "secret-token" for call in calls)
    assert calls[1]["body"] == {"runId": "run-1", "stage": "SEARCH", "searches": 2,
                                "note": "2 search(es)"}
