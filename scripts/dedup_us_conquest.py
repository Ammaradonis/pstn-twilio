"""Audit all U.S. Conquest tabs; --apply backs up the grid and removes duplicates.

Keep first occurrence of each normalised phone within each tab. Blank and
unrecognised phones are retained and reported. Credentials stay in environment
or ignored workers/email-finder/.cache/sheets-oauth.json.
"""
from __future__ import annotations
import argparse
import gzip
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "workers/email-finder/.cache"
REPORTS = ROOT / "workers/email-finder/reports"


def normalize_phone(raw: object) -> str | None:
    if isinstance(raw, float) and raw.is_integer():
        raw = int(raw)
    value = str(raw or "").strip()
    extension = re.search(r"(?:ext\.?|extension|x|#)\s*(\d+)\s*$", value, re.I)
    suffix = ";ext=" + extension[1] if extension else ""
    if extension:
        value = value[:extension.start()]
    digits = re.sub(r"\D", "", value)
    if digits.startswith("00"):
        digits = digits[2:]
    elif digits.startswith("011"):
        digits = digits[3:]
    if len(digits) == 10 and not value.startswith(("+", "00", "011")):
        digits = "1" + digits
    if not 7 <= len(digits) <= 15:
        return None
    return digits + suffix


def find_phone_column(header: list) -> int:
    names = {"phonenumber", "phone", "tel", "telephone", "mobile", "mobilenumber"}
    normalised = [re.sub(r"[\s_-]", "", str(c).lower()) for c in header]
    # Alaska and Alabama use the original lead-export header "number".
    if {"name", "websiteurl", "address", "number"}.issubset(normalised):
        names.add("number")
    columns = [i for i, c in enumerate(normalised) if c in names]
    if len(columns) != 1:
        raise ValueError(f"Expected one phone column; found {len(columns)}")
    return columns[0]


def audit(rows: list[list]) -> dict:
    if not rows:
        return {"data_rows": 0, "unique_phones": 0, "blank_phones": 0, "unrecognised_phones": 0, "duplicate_rows": []}
    column = find_phone_column(rows[0])
    seen, duplicates = set(), []
    blank = invalid = 0
    for index, row in enumerate(rows[1:], 1):
        raw = row[column] if column < len(row) else ""
        phone = normalize_phone(raw)
        if phone is None:
            if str(raw or "").strip():
                invalid += 1
            else:
                blank += 1
        elif phone in seen:
            duplicates.append(index)
        else:
            seen.add(phone)
    return {"data_rows": len(rows) - 1, "unique_phones": len(seen), "blank_phones": blank,
            "unrecognised_phones": invalid, "duplicate_rows": duplicates}


def deletion_requests(sheet_id: int, indices: list[int]) -> list[dict]:
    spans: list[list[int]] = []
    for index in sorted(set(indices)):
        if spans and spans[-1][1] == index:
            spans[-1][1] = index + 1
        else:
            spans.append([index, index + 1])
    return [{"deleteDimension": {"range": {"sheetId": sheet_id, "dimension": "ROWS",
             "startIndex": start, "endIndex": end}}} for start, end in reversed(spans)]


class Sheets:
    def __init__(self):
        path = CACHE / "sheets-oauth.json"
        local = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        self.credentials = {key: os.environ.get("GOOGLE_" + key) or local.get(key)
                            for key in ("CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN")}
        self.id = os.environ.get("US_CONQUEST_SPREADSHEET_ID") or local.get("SPREADSHEET_ID")
        if not self.id or not all(self.credentials.values()):
            raise RuntimeError("Sheets OAuth configuration is incomplete")
        self.base = f"https://sheets.googleapis.com/v4/spreadsheets/{self.id}"
        self.token = ""
        self.expiry = 0.0

    def request(self, suffix: str = "", body: dict | None = None) -> dict:
        if time.time() >= self.expiry:
            fields = {key.lower(): value for key, value in self.credentials.items()}
            fields["grant_type"] = "refresh_token"
            request = urllib.request.Request("https://oauth2.googleapis.com/token",
                                             data=urllib.parse.urlencode(fields).encode())
            with urllib.request.urlopen(request, timeout=30) as response:
                token = json.load(response)
            self.token = token["access_token"]
            self.expiry = time.time() + token.get("expires_in", 3600) - 60
        request = urllib.request.Request(self.base + suffix,
                    data=json.dumps(body).encode() if body is not None else None,
                    headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json",
                             "Accept-Encoding": "gzip", "User-Agent": "ConquestCleanup (gzip)"})
        # Never retry deletions blindly after an ambiguous response.
        for attempt in range(5):
            try:
                with urllib.request.urlopen(request, timeout=180) as response:
                    data = response.read()
                    if response.headers.get("Content-Encoding") == "gzip":
                        data = gzip.decompress(data)
                    return json.loads(data)
            except urllib.error.HTTPError as error:
                if body is None and error.code in (429, 500, 502, 503) and attempt < 4:
                    time.sleep(2 ** (attempt + 1))
                    continue
                raise RuntimeError(f"Sheets request failed with HTTP {error.code}") from None
        raise RuntimeError("Sheets read retries exhausted")

    def values(self, title: str) -> list[list]:
        quoted = "'" + title.replace("'", "''") + "'"
        return self.request("/values/" + urllib.parse.quote(quoted, safe="") +
                            "?valueRenderOption=FORMATTED_VALUE").get("values", [])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    api = Sheets()
    metadata = api.request("?fields=properties(title),sheets(properties)")
    if metadata["properties"]["title"] != "U.S. Conquest":
        raise RuntimeError("Configured spreadsheet is not U.S. Conquest")
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    output = REPORTS / ("us-conquest-" + stamp)
    output.mkdir(parents=True, exist_ok=True)
    report = {"spreadsheet": api.id, "mode": "apply" if args.apply else "audit", "sheets": []}
    report_path = output / "summary.json"
    if args.apply:
        print("Saving workbook metadata; each tab is backed up before edits...", flush=True)
        metadata_backup = api.request()
        (output / "workbook-metadata.json").write_text(json.dumps(metadata_backup), encoding="utf-8")
    for sheet in metadata["sheets"]:
        props = sheet["properties"]
        title = props["title"]
        if props.get("sheetType", "GRID") != "GRID":
            raise RuntimeError(f"Unsupported sheet type: {title}")
        time.sleep(1.1)
        rows = api.values(title)
        before = audit(rows)
        removed = len(before["duplicate_rows"])
        entry = {"title": title, "sheet_id": props["sheetId"], "before": before, "removed": 0}
        report["sheets"].append(entry)
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
        if args.apply and removed:
            # Back up editable cell data and layout without huge repeated effective formats.
            fields = "spreadsheetId,sheets(properties,merges,conditionalFormats,basicFilter,filterViews,protectedRanges,data(startRow,startColumn,rowData(values(userEnteredValue,userEnteredFormat,note,dataValidation,textFormatRuns)),rowMetadata,columnMetadata))"
            quoted = "'" + title.replace("'", "''") + "'"
            query = urllib.parse.urlencode({"includeGridData": "true", "ranges": quoted, "fields": fields})
            snapshot = api.request("?" + query)
            with gzip.open(output / f"tab-{props['sheetId']}-before.json.gz", "wt", encoding="utf-8") as handle:
                json.dump(snapshot, handle)
            del snapshot
            time.sleep(1.1)
            if api.values(title) != rows:
                raise RuntimeError(f"Sheet changed during audit: {title}; rerun from fresh data")
            api.request(":batchUpdate", {"requests": deletion_requests(props["sheetId"], before["duplicate_rows"])})
            entry["removed"] = removed
        if args.apply:
            time.sleep(1.1)
            after_rows = api.values(title)
            after = audit(after_rows)
            duplicates = set(before["duplicate_rows"])
            expected = [row for i, row in enumerate(rows) if i not in duplicates]
            if after["duplicate_rows"] or after_rows != expected:
                raise RuntimeError(f"Post-write verification failed: {title}")
            entry["after"] = after
            entry["verified"] = True
        print(f"{title}: {before['data_rows']} rows, {removed} duplicates, " +
              ("verified" if args.apply else "audited"), flush=True)
        report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    report["total_removed"] = sum(s["removed"] for s in report["sheets"])
    report["all_verified"] = args.apply and all(s.get("verified") for s in report["sheets"])
    report_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({"sheets": len(report["sheets"]), "removed": report["total_removed"],
                      "all_verified": report["all_verified"], "report": str(report_path)}), flush=True)


if __name__ == "__main__":
    main()
