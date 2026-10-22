"""The Facebook groups run, as the worker on the PC executes it.

The Dial page's button creates a run; this loop is what makes it move. Each
tick asks the API for the run and the batch it may do, does that batch on the
phone through `fb_groups.FacebookGroups`, and posts the deltas back.

Why the worker decides the stage: it holds the search plan, the group registry,
the caps and the phone's state. The API would have to duplicate all four to
schedule the next step, and the two copies would disagree the first time a
search found nothing.

The loop is deliberately boring. It never raises into the worker's research
loop, it treats every failure as "try again in a minute", and it does nothing at
all when no run is open.

    button ──► POST /fb-groups/start ──► FbGroupsRun (Postgres)
                                            ▲
       worker: tick ──► batch ──────────────┘
               progress (deltas, stage, note)
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass

import httpx

from .fb_addresses import CACHE_FILE, fetch_all, load
from .fb_engage import FbLimits, fb_limits
from .fb_groups import FacebookGroups, GroupCandidate, GroupRecord, GroupStore
from .fb_vocab import (
    PLAN_FILE,
    build_plan,
    coverage,
    keep,
    load_plan,
    save_plan,
    term_from,
    term_key,
)

log = logging.getLogger(__name__)

POLL_SECONDS = 20  # between batches while a run is open
IDLE_SECONDS = 90  # between checks while nothing is running
JOIN_THRESHOLD = 45
STAGE_CYCLE = ("SEARCH", "JOIN", "ENGAGE", "OUTREACH")


class FbRemote:
    """The worker's half of `/api/fb-groups/worker`."""

    def __init__(self, base: str, token: str) -> None:
        self._client = httpx.AsyncClient(
            base_url=f"{base.rstrip('/')}/api/fb-groups/worker",
            headers={"x-worker-token": token},
            timeout=60,
        )

    async def tick(self) -> dict:
        response = await self._client.post("tick")
        response.raise_for_status()
        return response.json() or {}

    async def progress(self, body: dict) -> None:
        response = await self._client.post("progress", json=body)
        response.raise_for_status()

    async def close(self) -> None:
        await self._client.aclose()


@dataclass
class Batch:
    """What one batch did, in the shape the API accumulates."""

    stage: str = "SEARCH"
    searches: int = 0
    groupsFound: int = 0
    joined: int = 0
    likes: int = 0
    comments: int = 0
    replies: int = 0
    follows: int = 0
    dms: int = 0
    reviewQueued: int = 0
    note: str = ""
    plan: dict | None = None

    def payload(self, run_id: str) -> dict:
        body: dict = {"runId": run_id, "stage": self.stage, "note": self.note[:500]}
        for name in ("searches", "groupsFound", "joined", "likes", "comments", "replies",
                     "follows", "dms", "reviewQueued"):
            value = getattr(self, name)
            if value:
                body[name] = int(value)
        if self.plan:
            body["plan"] = self.plan
        return body


class FbGroupsRunner:
    """One run at a time, executed through the phone the worker already owns."""

    def __init__(self, phone, remote: FbRemote, limits: FbLimits | None = None,
                 store: GroupStore | None = None, prompts=None) -> None:
        self.phone = phone
        self.remote = remote
        self.limits = limits or fb_limits()
        self.store = store or GroupStore(phone.cache)
        self.groups = FacebookGroups(phone, self.store, limits=self.limits,
                                     prompts=prompts if prompts is not None else self._default_prompts())
        self._plan: dict | None = None
        self._plan_summary: dict | None = None
        self._plan_reported = False

    @staticmethod
    def _default_prompts():
        from .fb_prompts import generate

        return generate

    # ── the plan ─────────────────────────────────────────────────────────────

    def plan(self) -> dict:
        """The search plan, built once per process and shared with the CLI."""
        if self._plan is not None:
            return self._plan
        if PLAN_FILE.is_file():
            self._plan = load_plan(PLAN_FILE)
            return self._plan
        if not CACHE_FILE.is_file():
            log.info("Facebook groups: reading both workbooks for the first time")
            fetch_all()
        records = load(CACHE_FILE)
        built = build_plan(records)
        report = coverage(records, built)
        if not report.complete:
            raise RuntimeError(
                f"{len(report.missing)} address(es) have no search behind them; "
                f"first: {report.missing[:3]}")
        save_plan(built)
        self._plan = load_plan(PLAN_FILE)
        self._plan_summary = {
            "addresses": report.addresses,
            "covered": report.covered,
            "searches": report.terms,
            "uncovered": len(report.missing),
            "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        log.info("Facebook groups: plan built — %d addresses covered by %d searches",
                 report.addresses, report.terms)
        return self._plan

    def plan_summary(self) -> dict | None:
        """Coverage for the button. Loads the plan first, so the first batch
        reports real numbers rather than an empty object."""
        if self._plan is None:
            self.plan()
        if self._plan_summary is None and self._plan is not None:
            self._plan_summary = {
                "addresses": 0, "covered": 0,
                "searches": len(self._plan.get("terms") or []),
                "uncovered": 0, "builtAt": None,
            }
        return self._plan_summary

    def next_searches(self, count: int) -> list[dict]:
        """The next `count` searches the plan has not run yet."""
        plan = self.plan()
        picked: list[dict] = []
        for term in plan.get("terms", []):
            if term.get("tier") not in (1, 2, 3):
                continue
            if self.store.searched(term_key(term["term"], term.get("country", ""))):
                continue
            picked.append(term)
            if len(picked) >= count:
                break
        return picked

    # ── the stages ───────────────────────────────────────────────────────────

    async def step(self, run: dict, batch: dict) -> Batch:
        result = Batch(stage=str(run.get("stage") or "SEARCH").upper())
        if result.stage not in STAGE_CYCLE:
            result.stage = "SEARCH"
        if not self.limits.enabled:
            result.note = "engagement is switched off (FB_GROUPS_ENGAGE=off)"
            return result
        before = len(self.store.review_queue())
        if result.stage == "SEARCH":
            result.note = await self._search(int(batch.get("searches") or 0), result)
        elif result.stage == "JOIN":
            result.note = await self._join(int(batch.get("joins") or 0), result)
        elif result.stage == "ENGAGE":
            result.note = await self._engage(int(batch.get("engagements") or 0), result)
        else:
            result.note = await self._outreach(int(batch.get("dms") or 0), result)
        result.reviewQueued = max(0, len(self.store.review_queue()) - before)
        return result

    async def _search(self, count: int, result: Batch) -> str:
        if not self._plan_reported:
            result.plan = self.plan_summary()
            self._plan_reported = True
        if count <= 0:
            # No budget in this batch: stay put rather than advancing on no work.
            return "no search budget in this batch"
        terms = self.next_searches(count)
        if not terms:
            result.stage = "JOIN"
            return "every search in the plan has run; moving on to joining"
        found = 0
        for payload in terms:
            candidates = await self.groups.search(term_from(payload))
            result.searches += 1
            if not candidates:
                continue
            for candidate in sorted(candidates, key=lambda c: -c.score):
                if not keep(candidate) or self.store.get(candidate.name):
                    continue
                self.store.put(GroupRecord(
                    name=candidate.name, url=candidate.url, score=candidate.score,
                    kind=candidate.kind, members=candidate.members,
                    privacy=candidate.privacy, found_by=payload["term"],
                    covers=int(payload.get("covers", 0)),
                    country=payload.get("country", "")))
                found += 1
        result.groupsFound = found
        result.stage = "SEARCH" if self.next_searches(1) else "JOIN"
        return f"{len(terms)} search(es), {found} new group(s)"

    async def _join(self, count: int, result: Batch) -> str:
        waiting = sorted((record for record in self.store.all()
                          if record.state == "candidate" and record.score >= JOIN_THRESHOLD),
                         key=lambda record: -record.score)
        if not waiting:
            result.stage = "ENGAGE"
            return "no group left to join; moving on to engaging"
        joined = 0
        for record in waiting[: max(1, count)]:
            joined_record = await self.groups.join(
                GroupCandidate(name=record.name, url=record.url, members=record.members,
                               score=record.score, kind=record.kind,
                               privacy=record.privacy, found_by=record.found_by),
                country=record.country, covers=record.covers)
            if joined_record.state in ("joined", "requested"):
                joined += 1
        result.joined = joined
        left = any(record.state == "candidate" and record.score >= JOIN_THRESHOLD
                   for record in self.store.all())
        result.stage = "JOIN" if left else "ENGAGE"
        return f"joined {joined} group(s)" if joined else "no join went through this batch"

    async def _engage(self, count: int, result: Batch) -> str:
        due = self.store.needs_visit()[: max(1, count)]
        if not due:
            result.stage = "OUTREACH"
            return "no group due a visit; moving on to outreach"
        for group in due:
            visit = await self.groups.visit(group)
            result.likes += visit.likes
            result.comments += visit.comments
            result.replies += visit.replies
            result.follows += visit.follows
            if visit.blocked:
                result.note = visit.blocked
        result.stage = "OUTREACH"
        return (f"{result.likes} like(s), {result.comments} comment(s), "
                f"{result.replies} reply(ies), {result.follows} follow(s)")

    async def _outreach(self, count: int, result: Batch) -> str:
        budget = max(1, count)
        sent = 0
        for group in self.store.needs_visit():
            if sent >= budget:
                break
            messages = await self.groups.outreach(group, max_dms=budget - sent)
            sent += len(messages)
        result.dms = sent
        # Outreach is the last stage; the pipeline starts again from searching so
        # the net keeps widening while the account stays inside its caps.
        result.stage = "SEARCH"
        return f"{sent} DM(s) sent" if sent else "nobody was eligible for a DM yet"

    # ── the loop ─────────────────────────────────────────────────────────────

    async def run_once(self) -> Batch | None:
        """One tick. None means there is no run to work on."""
        reply = await self.remote.tick()
        run = reply.get("run")
        if not run:
            return None
        result = await self.step(run, reply.get("batch") or {})
        await self.remote.progress(result.payload(run["id"]))
        log.info("Facebook groups [%s]: %s", result.stage, result.note)
        return result

    async def loop(self, stop: asyncio.Event) -> None:
        log.info("Facebook groups: watching for a run started from the Dial page")
        while not stop.is_set():
            delay = IDLE_SECONDS
            try:
                result = await self.run_once()
                if result is not None:
                    delay = POLL_SECONDS
            except httpx.HTTPStatusError as err:
                if err.response.status_code == 401:
                    log.error("the API rejected the worker token for Facebook groups; "
                              "check EMAIL_FINDER_WORKER_TOKEN")
                    delay = 600
                else:
                    log.warning("Facebook groups progress failed: %s", err)
            except httpx.HTTPError as err:
                log.warning("Facebook groups API unreachable: %s", err)
            except Exception:  # noqa: BLE001 - one bad batch must not stop the worker
                log.exception("Facebook groups batch failed; retrying")
            await _sleep(stop, delay)
        log.info("Facebook groups loop stopped")


async def _sleep(stop: asyncio.Event, seconds: float) -> None:
    try:
        await asyncio.wait_for(stop.wait(), timeout=seconds)
    except asyncio.TimeoutError:
        pass
