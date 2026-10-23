"""Facebook groups, end to end: plan, discover, join, engage, outreach.

    python scripts/fb_groups.py plan                 # addresses -> searches
    python scripts/fb_groups.py search --limit 20    # run searches on the phone
    python scripts/fb_groups.py join --top 5         # join what scored well
    python scripts/fb_groups.py engage --groups 3    # like/comment/reply/follow
    python scripts/fb_groups.py outreach --dms 5     # DM people with history
    python scripts/fb_groups.py review               # what a human should see
    python scripts/fb_groups.py report               # registry and caps

Every command is safe to run again: searches are remembered, a group is joined
once, a post is commented on once, and a person is messaged once. Nothing runs if
the phone is unavailable, paused after a checkpoint, or outside the account's
hours, and `--dry-run` never touches the phone at all.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from email_finder.cache import Cache
from email_finder.config import CACHE_DIR, load_settings
from email_finder.fb_addresses import CACHE_FILE, fetch_all, load, summarise
from email_finder.fb_engage import fb_limits
from email_finder.fb_groups import FacebookGroups, GroupRecord, GroupStore
from email_finder.fb_prompts import generate
from email_finder.fb_vocab import (
    PLAN_FILE,
    build_plan,
    coverage,
    keep,
    load_plan,
    save_plan,
    term_from,
)

log = logging.getLogger("fb-groups")


def _plan() -> dict:
    """Build (or reuse) the search plan, and print its coverage."""
    if not CACHE_FILE.is_file():
        log.info("No address snapshot yet; reading both workbooks.")
        fetch_all()
    records = load(CACHE_FILE)
    plan = build_plan(records)
    report = coverage(records, plan)
    print(json.dumps({
        "addresses": report.addresses,
        "covered_by_a_search": report.covered,
        "uncovered": len(report.missing),
        "local_searches": report.terms,
        "national_searches": len(plan.national),
        "by_tier": report.by_tier,
    }, indent=2))
    if not report.complete:
        print(f"{len(report.missing)} address(es) have no search behind them; "
              f"first: {report.missing[:3]}", file=sys.stderr)
        raise SystemExit(1)
    path = save_plan(plan)
    print(f"Plan written to {path}")
    return load_plan(path)


def _phone_and_groups() -> tuple[FacebookGroups, GroupStore]:
    from email_finder.android import Galaxy, find_adb

    settings = load_settings()
    if not settings.galaxy:
        raise SystemExit("The phone is turned off (EMAIL_FINDER_GALAXY=off).")
    adb = find_adb()
    if not adb:
        raise SystemExit("adb was not found; set EMAIL_FINDER_ADB or install platform-tools.")
    cache = Cache()
    phone = Galaxy(cache, adb, serial=settings.galaxy_serial,
                   daily_limit=settings.galaxy_daily_limit, ambient=settings.ambient)
    store = GroupStore(cache)
    groups = FacebookGroups(phone, store, limits=fb_limits(), prompts=generate)
    return groups, store


async def _search(groups: FacebookGroups, store: GroupStore, limit: int,
                  tiers: tuple[int, ...], join: bool, dry_run: bool) -> None:
    plan = load_plan(PLAN_FILE) if PLAN_FILE.is_file() else _plan()
    queue = groups.queue_searches(plan, limit=limit, tiers=tiers)
    if not queue:
        print("Every search in those tiers has already run.")
        return
    print(f"{len(queue)} search(es) queued; the phone does about one every 40 seconds.")
    for term in queue:
        if dry_run:
            print(f"  would search: {term['term']}  (covers {term.get('covers', 0)} school(s))")
            continue
        candidates = await groups.search(term_from(term))
        if not candidates:
            continue
        for candidate in sorted(candidates, key=lambda c: -c.score):
            if not keep(candidate):
                continue
            existing = store.get(candidate.name)
            if existing is not None:
                continue
            record = GroupRecord(
                name=candidate.name, url=candidate.url, score=candidate.score,
                kind=candidate.kind, members=candidate.members, privacy=candidate.privacy,
                found_by=term["term"], covers=int(term.get("covers", 0)),
                country=term["country"])
            store.put(record)
            print(f"  candidate: {candidate.name} ({candidate.score}) {candidate.url}")
            if join:
                joined = await groups.join(candidate, country=record.country,
                                           covers=record.covers)
                print(f"    -> {joined.state} ({joined.note})")





async def _join(groups: FacebookGroups, store: GroupStore, top: int) -> None:
    from email_finder.fb_vocab import GroupCandidate

    candidates = store.join_queue()[:top]
    if not candidates:
        print("No unjoined candidates above the threshold.")
        return
    for record in candidates:
        candidate = GroupCandidate(name=record.name, url=record.url, members=record.members,
                                   score=record.score, kind=record.kind,
                                   privacy=record.privacy, found_by=record.found_by)
        joined = await groups.join(candidate, country=record.country, covers=record.covers)
        print(f"{record.name}: {joined.state} ({joined.note})")


async def _engage(groups: FacebookGroups, store: GroupStore, count: int) -> None:
    groups_to_visit = store.needs_visit()[:count]
    if not groups_to_visit:
        print("No joined group is due a visit.")
        return
    for group in groups_to_visit:
        visit = await groups.visit(group)
        print(f"{group.name}: {visit.likes} like(s), {visit.comments} comment(s), "
              f"{visit.replies} reply(ies), {visit.follows} follow(s), "
              f"{visit.skipped} skipped"
              + (f" — blocked: {visit.blocked}" if visit.blocked else ""))


async def _outreach(groups: FacebookGroups, store: GroupStore, dms: int) -> None:
    sent_total = 0
    for group in store.joined():
        if sent_total >= dms:
            break
        sent = await groups.outreach(group, max_dms=dms - sent_total)
        for author, line in sent:
            sent_total += 1
            print(f"DM to {author} in {group.name}: {line[:90]}")
    if not sent_total:
        print("Nobody was eligible for a DM: outreach needs two interactions and three days.")


def _review(store: GroupStore) -> None:
    queue = store.review_queue()
    if not queue:
        print("The review queue is empty.")
        return
    for item in queue[-25:]:
        print(f"[{item.get('kind')}] {item.get('group', '')} — {item.get('why', '')}")
        text = item.get("text") or ""
        if text:
            print(f"    {text[:140]}")


def _report(store: GroupStore) -> None:
    limits = fb_limits()
    groups = store.all()
    state = store.state()
    print(json.dumps({
        "groups": len(groups),
        "joined": len([g for g in groups if g.state == "joined"]),
        "requested": len([g for g in groups if g.state == "requested"]),
        "candidates": len([g for g in groups if g.state == "candidate"]),
        "eligible_join_queue": len(store.join_queue()),
        "unverified_candidates": sum(not (g.members or g.privacy or g.url) for g in groups),
        "failed_or_refused": [{"name": g.name, "state": g.state, "reason": g.note}
                              for g in groups if g.state in ("failed", "refused")],
        "verified_actions": {key: len(state.get(key) or []) for key in
                             ("liked_posts", "commented_posts", "replied_comments",
                              "followed_authors", "dm_sent")},
        "searches_run": store.search_count(),
        "caps_per_day": {name: limits.cap(name, per_day=True) for name in
                         ("like", "comment", "reply", "follow", "dm", "join", "search")},
        "quiet_hours": limits.quiet_hours,
        "review_items": len(store.review_queue()),
    }, indent=2))


async def _run(args: argparse.Namespace) -> int:
    if args.command == "plan":
        _plan()
        return 0
    if args.command == "addresses":
        records = fetch_all(use_cache=not args.refresh)
        print(json.dumps(summarise(records), indent=2))
        return 0
    if args.command in ("review", "report"):
        # Neither needs the phone: they read the registry the phone wrote.
        store = GroupStore(Cache())
        _review(store) if args.command == "review" else _report(store)
        return 0
    groups, store = _phone_and_groups()
    if args.command == "search":
        await _search(groups, store, args.limit, tuple(args.tier), args.join, args.dry_run)
    elif args.command == "join":
        await _join(groups, store, args.top)
    elif args.command == "engage":
        await _engage(groups, store, args.groups)
    elif args.command == "outreach":
        await _outreach(groups, store, args.dms)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("addresses", help="read every address from both workbooks")
    p.add_argument("--refresh", action="store_true")

    sub.add_parser("plan", help="build the localized search plan")

    p = sub.add_parser("search", help="run searches on the phone")
    p.add_argument("--limit", type=int, default=20, help="searches per tier")
    p.add_argument("--tier", type=int, action="append", default=[1],
                   help="tier to run (repeatable; default 1)")
    p.add_argument("--join", action="store_true", help="join what passes the threshold")
    p.add_argument("--dry-run", action="store_true", help="print the queue only")

    p = sub.add_parser("join", help="join the best unjoined candidates")
    p.add_argument("--top", type=int, default=5)

    p = sub.add_parser("engage", help="visit joined groups and engage")
    p.add_argument("--groups", type=int, default=3)

    p = sub.add_parser("outreach", help="DM people with engagement history")
    p.add_argument("--dms", type=int, default=5)

    sub.add_parser("review", help="show what a human should look at")
    sub.add_parser("report", help="registry and caps")

    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    if not CACHE_DIR.exists():
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return asyncio.run(_run(args))


if __name__ == "__main__":
    raise SystemExit(main())
