"""Small SQLite cache so reruns don't pay twice for searches, DNS or pages."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

from .config import CACHE_DIR


class Cache:
    def __init__(self, path: Path | None = None) -> None:
        path = path or CACHE_DIR / "engine.sqlite"
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.execute(
            "create table if not exists kv (ns text, k text, v text, exp real, primary key (ns, k))"
        )
        self._db.execute(
            "create table if not exists counters (name text, day text, n integer, primary key (name, day))"
        )
        self._lock = threading.Lock()

    def get(self, ns: str, key: str) -> Any | None:
        with self._lock:
            row = self._db.execute("select v, exp from kv where ns=? and k=?", (ns, key)).fetchone()
        if not row or row[1] < time.time():
            return None
        return json.loads(row[0])

    def set(self, ns: str, key: str, value: Any, ttl: float) -> None:
        with self._lock:
            self._db.execute(
                "insert or replace into kv values (?, ?, ?, ?)",
                (ns, key, json.dumps(value), time.time() + ttl),
            )
            self._db.commit()

    def bump(self, name: str) -> int:
        """Increment today's counter and return the new value."""
        day = time.strftime("%Y-%m-%d")
        with self._lock:
            self._db.execute(
                "insert into counters values (?, ?, 1) on conflict(name, day) do update set n = n + 1",
                (name, day),
            )
            self._db.commit()
            return self._db.execute(
                "select n from counters where name=? and day=?", (name, day)
            ).fetchone()[0]

    def count(self, name: str) -> int:
        day = time.strftime("%Y-%m-%d")
        with self._lock:
            row = self._db.execute(
                "select n from counters where name=? and day=?", (name, day)
            ).fetchone()
        return row[0] if row else 0
