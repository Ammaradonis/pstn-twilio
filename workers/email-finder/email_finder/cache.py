"""Small SQLite cache so reruns don't pay twice for searches, DNS or pages."""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
import zlib
from pathlib import Path
from typing import Any

from .config import CACHE_DIR

log = logging.getLogger(__name__)
# Namespaces written by earlier worker versions and no longer read.
OBSOLETE_NAMESPACES = ("page", "render", "mx", "brave")
# Cached pages are full HTML; values this large are stored zlib-compressed.
COMPRESS_OVER = 2048
VACUUM_OVER_BYTES = 512 * 1024 * 1024


class Cache:
    def __init__(self, path: Path | None = None) -> None:
        path = path or CACHE_DIR / "engine.sqlite"
        path.parent.mkdir(parents=True, exist_ok=True)
        # Wait out another reader (a long query, a VACUUM) instead of failing after
        # SQLite's default five seconds.
        self._db = sqlite3.connect(path, timeout=120, check_same_thread=False)
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
        return _load(row[0])

    def set(self, ns: str, key: str, value: Any, ttl: float) -> None:
        with self._lock:
            self._db.execute(
                "insert or replace into kv values (?, ?, ?, ?)",
                (ns, key, _dump(value), time.time() + ttl),
            )
            self._db.commit()

    def items(self, ns: str) -> list[tuple[str, Any]]:
        with self._lock:
            rows = self._db.execute("select k, v from kv where ns=? and exp>?", (ns, time.time())).fetchall()
        return [(key, _load(value)) for key, value in rows]

    def delete(self, ns: str, key: str) -> None:
        with self._lock, self._db:
            self._db.execute("delete from kv where ns=? and k=?", (ns, key))

    def maintain(self, vacuum: bool = False) -> None:
        """Delete expired entries and those of older worker versions; nothing
        else ever removes them, and the file grew by gigabytes a day. VACUUM
        (which blocks the cache) gives the space back to the disk."""
        marks = ",".join("?" * len(OBSOLETE_NAMESPACES))
        with self._lock:
            with self._db:
                gone = self._db.execute(
                    f"delete from kv where exp < ? or ns in ({marks})",
                    (time.time(), *OBSOLETE_NAMESPACES),
                ).rowcount
            page = self._db.execute("pragma page_size").fetchone()[0]
            free = page * self._db.execute("pragma freelist_count").fetchone()[0]
            if vacuum and free > VACUUM_OVER_BYTES:
                log.info("Compacting the cache (%.1f GB unused)...", free / 1e9)
                self._db.execute("vacuum")
        if gone:
            log.info("Cache maintenance removed %d stale entries.", gone)

    def bump(self, name: str) -> int:
        """Increment today's counter and return the new value."""
        day = time.strftime("%Y-%m-%d", time.gmtime())
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
        day = time.strftime("%Y-%m-%d", time.gmtime())
        with self._lock:
            row = self._db.execute(
                "select n from counters where name=? and day=?", (name, day)
            ).fetchone()
        return row[0] if row else 0

    def reserve(self, name: str, limit: int) -> bool:
        """Atomically reserve an API call, including failures and retries."""
        day = time.strftime("%Y-%m-%d", time.gmtime())
        with self._lock, self._db:
            cursor = self._db.execute(
                "insert into counters values (?, ?, 1) on conflict(name, day) "
                "do update set n = n + 1 where n < ?", (name, day, limit),
            ) if limit > 0 else None
            return bool(cursor and cursor.rowcount)


def _dump(value: Any) -> str | bytes:
    text = json.dumps(value)
    return zlib.compress(text.encode(), 6) if len(text) > COMPRESS_OVER else text


def _load(stored: str | bytes) -> Any:
    return json.loads(zlib.decompress(stored) if isinstance(stored, bytes) else stored)
