# Local Meta ad prospecting

Four async workers share bounded queues on this laptop: scroll and snapshot,
extract advertiser evidence, compare school names across both workbooks, then
verify Facebook URLs and export matches. With `--apply`, the fourth worker also
calls the Sheets bridge to color verified rows light blue (`#9fc5e8`).

The confirmed scope is all U.S. and UK schools, both active and historical ads,
with **no age cutoff**. Use `--all-time`. This only covers ads Meta still exposes;
missing results never mean a school has never advertised. Country is the Ads
Library country filter, not proof of the school's address or precise targeting.

## Run from the repository root

```powershell
Push-Location apps/api
pnpm exec tsx --env-file=../../.env scripts/meta-ads-sheets.ts
Pop-Location
workers/email-finder/.venv/Scripts/python.exe workers/meta-ads/run.py --all-time --apply
```

For a hidden process at below-normal priority, run
`powershell -File workers/meta-ads/start.ps1` after refreshing the inventory.
Its stdout/stderr are saved as `worker.log` and `worker-error.log` in the output
directory. A process lock prevents concurrent runs using the same browser.

Uses the existing Google OAuth connection. With more than one connected account,
the bridge requires `--user=<id>`; it never silently chooses another account.
The two workbook IDs come from the application's existing config defaults and
environment overrides. All grid tabs are read, including hidden ones. `title`
is preferred; Alaska and Alabama use `name`. Tabs without either are reported.

The browser is a separate headless Edge profile in `.cache/meta-ads/browser`,
using the existing Facebook-only cookie export once. It does not control the
user's already-open browser. Login walls, challenges and access limits stop the
run for manual attention. Only one worker process should use this profile.

Keyword discovery uses martial arts terms in the U.S., then the UK, followed by
each unique school name (schools with saved Facebook URLs go first).
Each search scrolls until six passes yield no new ad IDs; this is recorded as
`stalled`, not as proof of exhaustive coverage. Use `--refresh` to revisit these
searches. Interrupted and scroll-limited searches restart on the next run, while
stored ads are deduplicated by country and Library ID. `--max-scrolls=N` bounds a
test pass; `--seed-only --seeds=1` runs only the first discovery term per country.

## Outputs and stopping

Everything containing school data or login state stays under ignored
`.cache/meta-ads/`:

- `inventory.json`: all tabs and school rows.
- `ads.sqlite`: durable ad evidence and query progress.
- `advertisers.csv`: full advertiser names, account URLs, ad IDs and dates.
- `prospects.csv` / `prospects.json`: matching rows and explicit review reasons.
- `status.json`: progress and any interruption.
- `sheets.log`, `color-audit-*.json`: write outcomes and previous row formats.

CSV exports update between searches and before writes. SQLite saves every
snapshot. To request a stop, create `.cache/meta-ads/STOP`; allow the current
page read and pending verified writes to finish. Remove this file before restart.

```powershell
New-Item -ItemType File -Path .cache/meta-ads/STOP -Force
```

Only matching normalized names **and** matching Facebook profile identities
qualify for blue. Tracking parameters, mobile hosts, trailing slashes and
numeric `profile.php` / `people` URLs are normalized. Different handles and
handle-versus-ID pairs are left for review; no identity is guessed. Missing
Facebook URLs, name differences, duplicated identities and changed rows are
exported for review. Nothing writes a missing Facebook URL automatically.

Before coloring, the bridge refreshes the workbooks, relocates the exact
name/URL within the same tab, then checks the live row again. It saves previous
background formats before writing only background fields. Sorting or editing
between the final read and the write can still race, since Sheets does not offer
an atomic compare-and-set operation; avoid sorting while writes are in progress.
Conditional formatting may override the visible background. Existing TRUE/FALSE
cells are untouched; `verified` is the exported match result.

Re-evaluate saved ads without new searches:

```powershell
workers/email-finder/.venv/Scripts/python.exe workers/meta-ads/run.py --replay-only --all-time --apply
```

Validation:

```powershell
workers/email-finder/.venv/Scripts/python.exe -m unittest discover -s workers/meta-ads -p "test_*.py"
```
