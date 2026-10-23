"""The worker must not be able to go quiet while it is still running.

"Workers are DEAD" on 23 Oct was a worker whose event loop had frozen on a
blocked cache read: the process was alive, so nothing restarted it, but no
heartbeat, claim or log line could happen either, and the app (rightly) reported
it offline. These cover the two halves of that: the deferral the API kept
rejecting, and the watcher that speaks from outside the loop.
"""
import logging
import subprocess
import threading
import time
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from email_finder import worker
from email_finder.engine import Finding


class _Stop:
    """An asyncio.Event stand-in: set after a few checks so a test ends."""

    def __init__(self, after: int) -> None:
        self.after = after
        self.checks = 0

    def is_set(self) -> bool:
        self.checks += 1
        return self.checks > self.after


class _TickingStop(_Stop):
    """A stop that also marks the loop as running, once per check."""

    def __init__(self, ticks: list[float], after: int = 2) -> None:
        super().__init__(after)
        self.ticks = ticks

    def is_set(self) -> bool:
        self.ticks[0] = time.monotonic()
        return super().is_set()


def _run_watchdog(ticks, stop, exit_process):
    thread = threading.Thread(target=worker.loop_watchdog, args=(ticks, stop, exit_process))
    thread.start()
    thread.join(timeout=10)
    assert not thread.is_alive()


def test_a_frozen_event_loop_is_reported_from_outside_it(monkeypatch, caplog):
    monkeypatch.setattr(worker, 'LOOP_TICK_SECONDS', 0.01)
    monkeypatch.setattr(worker, 'LOOP_STALL_WARN_SECONDS', 0.0)
    monkeypatch.setattr(worker, 'LOOP_STALL_RESTART_SECONDS', 600.0)
    caplog.set_level(logging.ERROR, logger='email_finder.worker')
    # The loop last ticked a minute ago, as a blocked call leaves it.
    _run_watchdog([time.monotonic() - 60], _Stop(after=2), lambda code: None)
    assert any('has not ticked' in record.message for record in caplog.records)


def test_a_loop_that_never_recovers_ends_the_process(monkeypatch):
    monkeypatch.setattr(worker, 'LOOP_TICK_SECONDS', 0.01)
    monkeypatch.setattr(worker, 'LOOP_STALL_WARN_SECONDS', 0.0)
    monkeypatch.setattr(worker, 'LOOP_STALL_RESTART_SECONDS', 0.0)
    # The real shutdown() closes handlers the rest of the suite still uses.
    monkeypatch.setattr(worker.logging, 'shutdown', lambda: None)
    exits = []
    _run_watchdog([time.monotonic() - 900], _Stop(after=50), exits.append)
    assert exits == [worker.EXIT_LOOP_STUCK]


def test_a_running_loop_is_left_alone(monkeypatch):
    monkeypatch.setattr(worker, 'LOOP_TICK_SECONDS', 0.01)
    monkeypatch.setattr(worker, 'LOOP_STALL_WARN_SECONDS', 5.0)
    monkeypatch.setattr(worker, 'LOOP_STALL_RESTART_SECONDS', 10.0)
    exits = []
    ticks = [time.monotonic()]
    _run_watchdog(ticks, _TickingStop(ticks), exits.append)
    assert exits == []


@pytest.mark.parametrize('deferral, sent', [
    (21819.450847148895, 21819),   # the phone's pause: time arithmetic, fractional
    (1800.0, 1800),
    (10, 60),                      # the API's floor
    (10 * 86400, 86400),           # the API's ceiling
])
def test_retry_after_is_whole_seconds_inside_the_api_window(deferral, sent):
    result = worker.to_result('row', Finding(retry_after=deferral, research_complete=False), 'lease')
    assert result['status'] == 'RETRY'
    assert result['retryAfter'] == sent
    assert isinstance(result['retryAfter'], int)


def test_no_deferral_sends_no_retry_after():
    assert 'retryAfter' not in worker.to_result('row', Finding(), 'lease')


def test_a_hung_import_check_keeps_the_running_worker(monkeypatch):
    """The check that decides whether new code imports must never crash the worker.

    On this PC one `import email_finder.worker` took over 300 s, the timeout
    raised uncaught, and the worker exited instead of restarting."""
    stale = (('worker.py', 1),)
    # Changed a minute ago, so the code-stamp settle check is already past.
    current = (('worker.py', int((time.time() - 60) * 1e9)),)
    monkeypatch.setattr(worker, 'code_stamp', lambda: current)

    def hung(*args, **kwargs):
        raise subprocess.TimeoutExpired(cmd='python', timeout=300)

    monkeypatch.setattr(worker.subprocess, 'run', hung)
    assert worker.new_code_ready(stale, set()) is False
