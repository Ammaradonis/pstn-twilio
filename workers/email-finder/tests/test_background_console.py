"""Verify that the real command runner cannot allocate a Windows console."""

import asyncio
import os
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from email_finder.android import Galaxy
from email_finder.cache import Cache


@pytest.mark.skipif(os.name != "nt", reason="Windows console allocation")
def test_background_command_has_no_console_and_captures_output(tmp_path):
    # Use a real console executable through exactly the same path as adb.
    # This checks OS behavior, not just whether a mocked spawn receives a flag.
    phone = Galaxy(Cache(tmp_path / "cache.db"), sys.executable)
    script = (
        "import ctypes, sys; "
        "print('console=' + str(ctypes.windll.kernel32.GetConsoleWindow()), flush=True); "
        "print('stderr captured', file=sys.stderr, flush=True)"
    )
    output = asyncio.run(phone._run("-c", script, tries=1))
    assert output.splitlines() == ["console=0", "stderr captured"]
