# Local Meta ad prospecting

Four async workers share bounded queues on this laptop: scroll and snapshot,
extract advertiser evidence, compare school names across both workbooks, then
verify Facebook URLs and export matches. With `--apply`, the fourth worker also
calls the Sheets bridge to color verified rows light blue (`#9fc5e8`).

Every evidenced match is also uploaded to the app (`remote.py`), so the Dial
page's **Meta ad filter** button can copy the matching rows into a new tab of the
selected spreadsheet. See [The app's Meta ad filter](#the-apps-meta-ad-filter).

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
stored ads are deduplicated by country and Library ID. A page that times out or
drops mid-search is recorded as `error` and retried on a later run: one slow read
used to raise through the pass and end it. `--max-scrolls=N` bounds a test pass;
`--seed-only --seeds=1` runs only the first discovery term per country.

## Outputs and stopping

Everything containing school data or login state stays under ignored
`.cache/meta-ads/`:

- `inventory.json`: all tabs and school rows.
- `ads.sqlite`: durable ad evidence and query progress.
- `advertisers.csv`: full advertiser names, account URLs, ad IDs and dates.
- `prospects.csv` / `prospects.json`: matching rows and explicit review reasons.
- `status.json`: progress, any interruption, the upload state under `sync`, and
  the sheet write under `apply`. A failed write is reported there and retried
  after five minutes; it no longer ends the pass.
- `sheets.log`, `color-audit-*.json`: write outcomes and previous row formats.
- `sync.log`: rejected or failed uploads to the app, with the API's reply.

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
exported for review as `name_review`, `missing_facebook_url`,
`facebook_url_mismatch` and `dates_pending_or_outside_range`.

There are **two** match decisions, and they are not the same one:

| decision   | what it needs                                           | what it does                    |
| ---------- | ------------------------------------------------------- | ------------------------------- |
| `verified` | the name **and** the page                               | blue background with `--apply`  |
| `evidence` | the page, **or** an exact name when the tab has no page | uploaded for the Meta ad filter |

The second one exists because 92% of the rows in both workbooks have no
`facebookUrl` at all. On 23 Oct, 188 of the 209 candidates were dropped as
`missing_facebook_url`, only two rows reached the app, and the Dial page's
button looked dead. An exact normalized name with no page on the row is now
evidence, tagged `matchKind: "name"`, and the filter tab carries the advertiser's
page in `metaAdvertiser` so the reader can see where the ad ran. Blue stays
strict: a name alone never colours a row.

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

## The app's Meta ad filter

The Dial page has a **Meta ad filter** button next to the sheet picker. It
creates a new tab in the _same_ spreadsheet, holding only the rows of the
selected tab whose school advertises on Meta:

- **Still advertising now** (the default): the school has an ad the worker saw
  running in the last 30 days. Older "Active" observations are not claimed as
  current, and the button reports how many were left out for that reason.
- **Advertised in the past**: the school has an ad that has ended. A school that
  has ended ads and is running new ones appears in both lists.

Each copied row keeps every source column and gains `metaAdId`, `metaAdStatus`,
`metaAdStarted`, `metaAdEnded`, `metaAdvertiser`, `metaAdObservedAt` and
`metaMatch`, so any row can be traced back to the ad that matched it. `metaMatch`
is `page` when the tab's own `facebookUrl` cell is the ad's page and `name` when
the tab had no page URL and the exact school name is what matched. The tab is
named `Meta ads - running now - <tab>` or `Meta ads - ran in the past - <tab>`;
pressing the button again rewrites that tab instead of stacking copies.

The evidence behind it is uploaded as the run progresses (at most every two
minutes, and once when the run ends), so the button works while a long scrape is
still going. A row that names a page only accepts ads from that page; a row with
no page URL is matched by its exact name, and only when every ad for that name
comes from one page. A tab that was sorted since the match still lines up.

Uploads use `EMAIL_FINDER_WORKER_TOKEN` and the API at `META_ADS_API_BASE`, then
`EMAIL_FINDER_API_BASE`, `PUBLIC_BASE_URL`, then `https://api.bestsoftphone.site`.
They go one tab per request, so a tab the API rejects costs only itself.
Turn them off with `--no-sync`; upload an earlier run's `prospects.json` without
opening a browser with `--sync-only` (it re-decides `evidence` from the stored
`nameMatch`/`urlMatch`/`dateMatch` flags, so a rule change applies without a new
scrape).

```powershell
workers/email-finder/.venv/Scripts/python.exe workers/meta-ads/run.py --sync-only
```

Validation:

```powershell
workers/email-finder/.venv/Scripts/python.exe -m unittest discover -s workers/meta-ads -p "test_*.py"
```
