"""Reset today's local lookup usage, keeping other worker state intact."""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
import re
import sqlite3


LOOKUP_COUNTERS = {"google-web", "google-cse", "social-facebook", "social-instagram", "galaxy"}


def reset_lookup_limits(database: Path, *, day: str | None = None) -> dict[str, int]:
    now = dt.datetime.now(dt.timezone.utc)
    day = day or now.date().isoformat()  # Same UTC day as Cache.reserve().
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=rw", uri=True, timeout=120)
    try:
        with connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute("SELECT name, n FROM counters WHERE day = ?", (day,)).fetchall()
            previous = {name: count for name, count in rows if name in LOOKUP_COUNTERS
                        or re.fullmatch(r"(?:google|brave):[0-9a-f]{12}", name)}
            connection.executemany("UPDATE counters SET n = 0 WHERE day = ? AND name = ?",
                                   [(day, name) for name in previous])
            audit = database.parent / f"lookup-reset-{now.strftime('%Y%m%dT%H%M%S%fZ')}.json"
            audit.write_text(json.dumps({"resetAt": now.isoformat(), "counterDayUtc": day,
                                         "previousCounts": previous}, indent=2) + "\n", encoding="utf-8")
        return previous
    finally:
        connection.close()


def main() -> None:
    database = Path(__file__).resolve().parents[1] / ".cache" / "engine.sqlite"
    previous = reset_lookup_limits(database)
    print(f"Reset {len(previous)} lookup counters for today (UTC).")
    for name, count in sorted(previous.items()):
        print(f"  {name}: {count} -> 0")
    print("Configured limits, saved sessions, cached results, security pauses and engagement counters are unchanged.")
    print("This resets local usage only; provider-side credits and quotas are unchanged.")


if __name__ == "__main__":
    main()
