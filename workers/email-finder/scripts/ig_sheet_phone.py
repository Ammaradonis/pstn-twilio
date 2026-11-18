"""Write rows to a Google spreadsheet through Chrome on the phone, in its signed-in account.

The fallback for ig_bio_links.py when the connected Google account's API token has
lapsed. It drives one tab of the phone's Chrome over USB debugging: new rows are
pasted at the first empty row, then read back, and a write only counts as done if
the read-back shows it. The user's other tabs are never looked at or touched.
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import re
import subprocess
from pathlib import Path
from urllib.parse import quote

import httpx
import websockets

CHROME = "com.android.chrome"
DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36"
SHEET_URL = re.compile(r"docs\.google\.com/spreadsheets/(?:u/\d+/)?d/([\w-]+)")  # the mobile page adds /u/0
PORT = 9333
READY_S = 60
SETTLE_S = 2.0
# A cell starting with one of these would run as a formula. Bios come from strangers,
# so without this one could call IMPORTXML and read the rest of the sheet out.
FORMULA_START = ("=", "+", "-", "@")


class SheetError(RuntimeError):
    pass


def clean_cell(value: object) -> str:
    text = re.sub(r"\s*[\r\n\t]+\s*", " / ", str(value if value is not None else "")).strip()
    return " " + text if text.startswith(FORMULA_START) else text


def to_tsv(rows: list[list[object]]) -> str:
    return "\n".join("\t".join(clean_cell(cell) for cell in row) for row in rows)


def parse_column(text: str) -> list[str]:
    """A one-column CSV from the read-back, keeping empty rows so positions stay right."""
    return [row[0] if row else "" for row in csv.reader(io.StringIO(text))]


def first_empty_row(column: list[str]) -> int:
    filled = [i for i, value in enumerate(column) if value.strip()]
    return (filled[-1] + 2) if filled else 1


class PhoneSheet:
    def __init__(self, galaxy, adb: str, serial: str | None) -> None:
        self.g, self.adb, self.serial = galaxy, adb, serial
        self.ws = None
        self.tab: dict | None = None
        self._id = 0

    def _adb(self, *args: str) -> None:
        cmd = [self.adb] + (["-s", self.serial] if self.serial else []) + list(args)
        subprocess.run(cmd, capture_output=True, timeout=20,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    async def open(self, spreadsheet_id: str | None) -> str:
        """Open the sheet (or a new one) and return its ID."""
        self._adb("forward", f"tcp:{PORT}", "localabstract:chrome_devtools_remote")
        url = (f"https://docs.google.com/spreadsheets/d/{spreadsheet_id}/edit" if spreadsheet_id
               else "https://sheets.new")
        await self.g._shell("input keyevent KEYCODE_WAKEUP")
        async with httpx.AsyncClient(timeout=20) as client:
            # Tabs already open are the user's. A new sheet must come from a tab opened
            # here, or a spreadsheet they had open could be written to by mistake.
            before = {p.get("id") for p in await self._pages(client)}
            await self.g._shell(f"am start -a android.intent.action.VIEW -d {url} -p {CHROME} --ez create_new_tab true")
            for _ in range(READY_S // 2):
                await asyncio.sleep(2)
                pages = [p for p in await self._pages(client) if p.get("type") == "page"
                         and (m := SHEET_URL.search(p.get("url", ""))) and p.get("webSocketDebuggerUrl")
                         and spreadsheet_id in (None, m[1])]
                self.tab = next((p for p in pages if p.get("id") not in before), None)
                if self.tab or (spreadsheet_id and pages):
                    self.tab = self.tab or pages[0]
                    break
        if not self.tab:
            raise SheetError("the spreadsheet did not open in Chrome on the phone")
        found = SHEET_URL.search(self.tab["url"])
        self.ws = await websockets.connect(self.tab["webSocketDebuggerUrl"], max_size=None, origin=None)
        # A reopened sheet gets the read-only mobile page. This asks this one tab for
        # the same desktop page Chrome's own "Desktop site" setting gets on this phone.
        await self._call("Emulation.setUserAgentOverride", userAgent=DESKTOP_UA)
        await self._call("Emulation.setDeviceMetricsOverride", width=1280, height=900, deviceScaleFactor=1,
                         mobile=False)
        await self._call("Page.navigate", url=f"https://docs.google.com/spreadsheets/d/{found[1]}/edit")
        await asyncio.sleep(SETTLE_S)
        for _ in range(READY_S // 2):
            if await self.eval("!!document.querySelector('.docs-sheet-tab') && "
                               "!!document.querySelector('.cell-input') && "
                               "!!document.querySelector('#t-name-box')"):
                break
            await asyncio.sleep(2)
        else:
            page = await self.eval("location.host")
            raise SheetError(f"the spreadsheet editor did not load (on {page}); is Chrome signed in?")
        await asyncio.sleep(SETTLE_S * 2)  # the grid accepts input a little after it draws
        return found[1]

    @staticmethod
    async def _pages(client: httpx.AsyncClient) -> list[dict]:
        try:
            return (await client.get(f"http://127.0.0.1:{PORT}/json/list")).json()
        except (httpx.HTTPError, ValueError):
            return []

    async def close(self) -> None:
        if self.ws:
            await self.ws.close()
        if self.tab:
            try:
                async with httpx.AsyncClient(timeout=15) as client:
                    await client.get(f"http://127.0.0.1:{PORT}/json/close/{self.tab['id']}")
            except httpx.HTTPError:
                pass
        self._adb("forward", "--remove", f"tcp:{PORT}")

    async def _call(self, method: str, **params) -> dict:
        self._id += 1
        call_id = self._id
        await self.ws.send(json.dumps({"id": call_id, "method": method, "params": params}))
        while True:
            message = json.loads(await asyncio.wait_for(self.ws.recv(), 60))
            if message.get("id") == call_id:
                if "error" in message:
                    raise SheetError(f"{method}: {message['error'].get('message', '')[:120]}")
                return message.get("result", {})

    async def eval(self, expression: str, wait: bool = False):
        out = await self._call("Runtime.evaluate", expression=expression, returnByValue=True, awaitPromise=wait)
        if "exceptionDetails" in out:
            raise SheetError(f"page script failed: {out['exceptionDetails'].get('text', '')[:120]}")
        return out.get("result", {}).get("value")

    async def _key(self, key: str, code: int) -> None:
        for kind in ("rawKeyDown", "keyUp"):
            await self._call("Input.dispatchKeyEvent", type=kind, key=key, code=key,
                             windowsVirtualKeyCode=code, nativeVirtualKeyCode=code)

    async def _enter(self) -> None:
        await self._call("Input.dispatchKeyEvent", type="keyDown", key="Enter", code="Enter",
                         windowsVirtualKeyCode=13, nativeVirtualKeyCode=13, text="\r")
        await self._call("Input.dispatchKeyEvent", type="keyUp", key="Enter", code="Enter",
                         windowsVirtualKeyCode=13, nativeVirtualKeyCode=13)

    async def _click(self, selector_js: str, count: int = 1) -> None:
        box = await self.eval(f"(() => {{ const e = {selector_js}; if (!e) return null; "
                              "const r = e.getBoundingClientRect(); "
                              "return {x: r.left + r.width / 2, y: r.top + r.height / 2}; })()")
        if not box:
            raise SheetError(f"not on the page: {selector_js[:70]}")
        for n in range(1, count + 1):
            for kind in ("mousePressed", "mouseReleased"):
                await self._call("Input.dispatchMouseEvent", type=kind, x=box["x"], y=box["y"],
                                 button="left", buttons=1, clickCount=n)
        await asyncio.sleep(0.8)

    async def set_title(self, title: str) -> None:
        if await self.eval("document.querySelector('.docs-title-input').value") == title:
            return
        await self._click("document.querySelector('.docs-title-input')")
        await self.eval("document.querySelector('.docs-title-input').select()")
        await self._call("Input.insertText", text=title)
        await self._enter()
        await asyncio.sleep(SETTLE_S)

    async def tabs(self) -> list[str]:
        return await self.eval("[...document.querySelectorAll('.docs-sheet-tab .docs-sheet-tab-name')]"
                               ".map(e => e.textContent)")

    def _tab_js(self, name: str) -> str:
        return ("[...document.querySelectorAll('.docs-sheet-tab .docs-sheet-tab-name')]"
                f".find(e => e.textContent === {json.dumps(name)})")

    async def _rename_active(self, name: str) -> None:
        await self._click("document.querySelector('.docs-sheet-active-tab .docs-sheet-tab-name')", 2)
        await asyncio.sleep(1)
        # A real key press closes the rename box and lands in a cell instead, so the
        # name is set and committed from inside the page.
        await self.eval("(() => { const e = document.querySelector('.docs-sheet-active-tab .docs-sheet-tab-name'); "
                        f"e.textContent = {json.dumps(name)}; "
                        "for (const type of ['keydown', 'keypress', 'keyup']) e.dispatchEvent(new KeyboardEvent(type, "
                        "{key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true})); })()")
        await asyncio.sleep(SETTLE_S)

    async def ensure_tab(self, name: str, rename_first: bool = False) -> None:
        names = await self.tabs()
        if name in names:
            await self._click(self._tab_js(name))
        elif rename_first and names == ["Sheet1"]:
            await self._rename_active(name)
        else:
            await self._click("document.querySelector('.docs-sheet-add-button')")
            await asyncio.sleep(SETTLE_S)
            await self._rename_active(name)
        if name not in await self.tabs():
            raise SheetError(f"could not create the {name!r} tab")
        await asyncio.sleep(SETTLE_S)

    async def read_column(self, spreadsheet_id: str, tab: str, column: str) -> list[str]:
        """Read through the sheet's own query endpoint: the grid is drawn on a canvas."""
        path = (f"/spreadsheets/d/{spreadsheet_id}/gviz/tq?tqx=out:csv&headers=0"
                f"&sheet={quote(tab)}&range={column}1:{column}20000")
        text = await self.eval(f"fetch({json.dumps(path)}, {{credentials: 'include', cache: 'no-store'}})"
                               ".then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))",
                               wait=True)
        return parse_column(text or "")

    async def _go_to(self, cell: str) -> None:
        await self._click("document.querySelector('#t-name-box, .waffle-name-box')")
        await self.eval("(document.querySelector('#t-name-box, .waffle-name-box')).select()")
        await self._call("Input.insertText", text=cell)
        await self._enter()
        await asyncio.sleep(1)

    async def paste_at(self, cell: str, rows: list[list[object]]) -> None:
        await self._go_to(cell)
        script = ("(() => { const t = document.querySelector('.cell-input'); t.focus(); "
                  "const data = new DataTransfer(); "
                  f"data.setData('text/plain', {json.dumps(to_tsv(rows))}); "
                  "return t.dispatchEvent(new ClipboardEvent('paste', "
                  "{clipboardData: data, bubbles: true, cancelable: true})); })()")
        await self.eval(script)
        await asyncio.sleep(SETTLE_S + len(rows) * 0.05)

    async def _keys(self, spreadsheet_id: str, tab: str, key_columns: str) -> list[tuple[str, ...]]:
        columns = [await self.read_column(spreadsheet_id, tab, c) for c in key_columns]
        longest = max(len(c) for c in columns)
        return [tuple((c[i] if i < len(c) else "").strip() for c in columns) for i in range(longest)]

    async def append_new(self, spreadsheet_id: str, tab: str, headers: list[str], rows: list[list[object]],
                         key_columns: str, key_indexes: tuple[int, ...], rename_first: bool = False) -> int:
        """Paste the rows whose key isn't on the tab yet; read back to prove it. Returns how many.

        The query endpoint leaves out values that don't fit a column's dominant type and
        closes the gap, so positions can only be trusted in columns that are always text.
        A username can be all digits; the profile URL and bio link columns can't.
        """
        await self.ensure_tab(tab, rename_first)
        key_of = lambda row: tuple(str(row[i]).strip() for i in key_indexes)  # noqa: E731
        keys = await self._keys(spreadsheet_id, tab, key_columns)
        have = set(keys)
        fresh = [r for r in rows if key_of(r) not in have]
        if not keys or keys[0] != key_of(headers):
            await self.paste_at("A1", [headers])
            keys = [key_of(headers), *keys[1:]]
        if not fresh:
            return 0
        await self.paste_at(f"A{first_empty_row([key[0] for key in keys])}", fresh)
        for _ in range(10):
            after = set(await self._keys(spreadsheet_id, tab, key_columns))
            if all(key_of(r) in after for r in fresh):
                return len(fresh)
            await asyncio.sleep(3)
        raise SheetError(f"the {tab!r} tab did not show the pasted rows when read back")


async def write_sheet(galaxy, adb: str, serial: str | None, state_path: Path, title: str, tabs: list[dict]) -> str:
    """Create or update the spreadsheet. `tabs`: name, headers, rows, key_columns, key_indexes.
    Returns a summary line in the same form the API uploader prints."""
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
    if not await galaxy._hold_phone(150):
        raise SheetError("the phone is busy with another process")
    sheet = PhoneSheet(galaxy, adb, serial)
    try:
        spreadsheet_id = await sheet.open(state.get("spreadsheetId"))
        state_path.write_text(json.dumps({"spreadsheetId": spreadsheet_id}), encoding="utf-8")
        await sheet.set_title(title)
        counts = []
        for i, tab in enumerate(tabs):
            added = await sheet.append_new(spreadsheet_id, tab["name"], tab["headers"], tab["rows"],
                                           tab["key_columns"], tab["key_indexes"], rename_first=i == 0)
            counts.append(f"{tab['name']}+{added}")
        return (f"SHEET via phone: {', '.join(counts)} "
                f"url=https://docs.google.com/spreadsheets/d/{spreadsheet_id}/edit")
    finally:
        await sheet.close()
        await galaxy._leave("home")
        galaxy._release_phone()
