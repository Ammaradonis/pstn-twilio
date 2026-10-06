import importlib.util
import json
from pathlib import Path
import sqlite3

import pytest


spec = importlib.util.spec_from_file_location(
    "reset_lookup_limits", Path(__file__).resolve().parents[1] / "scripts" / "reset_lookup_limits.py")
reset = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reset)


def test_reset_preserves_other_days_engagement_and_cached_state(tmp_path):
    database = tmp_path / "engine.sqlite"
    with sqlite3.connect(database) as connection:
        connection.execute("CREATE TABLE counters (name TEXT, day TEXT, n INTEGER, PRIMARY KEY(name, day))")
        connection.execute("CREATE TABLE kv (ns TEXT, k TEXT, v TEXT)")
        connection.executemany("INSERT INTO counters VALUES (?, ?, ?)", [
            ("google-web", "2026-10-05", 150), ("social-facebook", "2026-10-05", 200),
            ("social-instagram", "2026-10-05", 200), ("galaxy", "2026-10-05", 150),
            ("google-cse", "2026-10-05", 83), ("brave:012345abcdef", "2026-10-05", 300),
            ("google:012345abcdef", "2026-10-05", 100),
            ("ambient-follow", "2026-10-05", 5), ("ambient-slice", "2026-10-05", 116),
            ("google-web", "2026-10-04", 150), ("unrelated", "2026-10-05", 17),
        ])
        connection.execute("INSERT INTO kv VALUES ('social-state', 'galaxy-pause', 'preserve')")
    previous = reset.reset_lookup_limits(database, day="2026-10-05")
    assert len(previous) == 7
    with sqlite3.connect(database) as connection:
        rows = {(name, day): count for name, day, count in connection.execute("SELECT * FROM counters")}
        assert all(rows[name, "2026-10-05"] == 0 for name in previous)
        assert rows["google-web", "2026-10-04"] == 150
        assert rows["ambient-follow", "2026-10-05"] == 5
        assert rows["ambient-slice", "2026-10-05"] == 116
        assert rows["unrelated", "2026-10-05"] == 17
        assert connection.execute("SELECT v FROM kv").fetchone() == ("preserve",)
    audit = json.loads(next(tmp_path.glob("lookup-reset-*.json")).read_text())
    assert audit["previousCounts"] == previous
    assert audit["counterDayUtc"] == "2026-10-05"


def test_missing_database_is_not_silently_created(tmp_path):
    database = tmp_path / "missing.sqlite"
    with pytest.raises(sqlite3.OperationalError):
        reset.reset_lookup_limits(database)
    assert not database.exists()
