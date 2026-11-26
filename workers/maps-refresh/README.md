# U.S. Conquest weekly Maps refresh

Keeps the **U.S. Conquest** Google Sheet current from Google Maps, using the scraper in
`C:\Users\FingerWeg\CascadeProjects\real-google-maps-scraper` (override with `MAPS_SCRAPER_DIR`).
The UK sheet is not touched.

Every week, for all 50 states in the order of the scraper's `all-us-counties.txt`:

1. **Searches.** One `martial arts schools in <County>, <State>, USA` search per county in
   `all-us-counties.txt`, anchored on the county (census centroid and zoom). Map-tile searches cover areas
   where the sheet already lists many schools, because Maps cuts a list off at about 120. Finer tiles
   cover the areas where last week's lists were cut off.
2. **Scrape.** The scraper's CLI (`cliV2.js --strict-validation`, production profile) runs in a new
   folder each week, so every phone number is read fresh.
3. **Sync.**
   - **Column G:** a row whose place (matched by the Google place id in its `placeUrl`) now lists a
     different phone number gets the new number. Numbers that differ only in formatting are left as
     they are. A listing that shows no phone this week never blanks the cell.
   - **websiteUrl:** replaced when Maps lists a different site for the place. Differences of scheme,
     `www.`, a trailing slash or `utm_` tags don't count. No website on Maps never blanks the cell.
   - **openingTimes:** a column each tab gets after its last used column (`node … columns` adds it
     without running a scrape), so no existing column moves. One line per school:
     `Mon–Thu 4–9 PM; Fri 4–8 PM; Sat 9 AM–12 PM; Sun closed`.
     - The source is the place's Maps panel (its Google Business Profile). The scraper opens the
       collapsed hours row to read the week.
     - A day Maps shows holiday hours for (Thanksgiving, "Hours might differ") reads `holiday`, not
       the holiday's times. A holiday-week line never replaces a cell with more regular days; the next
       pass replaces it.
     - When Maps lists no hours and the cell is empty, the school's website is read: schema.org
       opening hours, then text under an "Hours" heading on the homepage and up to two contact/about
       pages. Class timetables (a day listed twice with different times) are not taken as opening
       hours. Answers are cached per week in `website-hours.json`.
     - A cell is never blanked, and website hours only fill an empty cell.
   - **New schools:**
     - A martial arts place (relevance `relevant`, not permanently closed) that is in no tab is added
       at the bottom of the tab for the state in its address, with its opening times.
     - A place already listed anywhere in the workbook is not added again. The workbook is checked by
       place id, phone number, and name plus address.
     - Columns the scraper doesn't fill (email, Status, …) stay blank.
     - Values are written as text (`RAW`), so nothing is read as a formula.
   - Right before writing, each row is checked again. A row that was moved or edited in the meantime
     is skipped.

## Running

```powershell
node workers/maps-refresh/refresh.cjs run          # this week's run: starts it or resumes it
node workers/maps-refresh/refresh.cjs status       # progress of the current run
node workers/maps-refresh/refresh.cjs state DE --dry-run   # one state now; writes sync-plan.json only
node workers/maps-refresh/refresh.cjs sync DE --from <scrape folder> [--dry-run]
node workers/maps-refresh/refresh.cjs columns [--dry-run]  # add the openingTimes column to every tab
node --test workers/maps-refresh/lib.test.cjs workers/maps-refresh/hours.test.cjs   # unit tests
```

The scheduled task **BestSoftphone Maps Refresh** (`install-task.ps1`) calls `run` at log-in and every
hour, without showing a window:

- A new run starts each ISO week once the previous run has finished.
- A run cut off by a reboot or sleep picks up at the state and search where it stopped.
- If a state fails, for example because Google pushes back, the run waits 1 h, then 2 h, 4 h and so
  on before it tries again.
- A state that fails 4 times is skipped until next week.

## Capacity

A full pass is about 4,760 searches: 3,144 counties plus about 1,600 tiles. The scraper reads one place
page every ~11 s per browser.

On the 3.9 GB office PC, the scraper's memory guard allows only one browser alongside the email
finder. A pass then takes an estimated 8–10 days of uninterrupted running. A pass that runs past its
week isn't cut short: it finishes, and the next one starts right after.

On a machine with 8 GB or more, the three configured browsers fit, and a pass takes about 3 days.

## Files

Everything lives under `.cache/maps-refresh/` (gitignored):

- `state.json`: one entry per weekly run, with each state's progress and counts.
- `added-places.json`: every place the refresh has added. A school you delete from the sheet is not
  added again.
- `refresh.log`: one line per state.
- `<week>/<ST>/`: a state's scrape for that week. It holds `jobs.txt`, `scraper.log`, `out/master.csv`,
  `sync-plan.json`, `phone-changes.csv` (tab, row, school, old and new number), `field-changes.csv`
  (websiteUrl and openingTimes changes, with the source), `website-hours.json`, `added.csv`, and
  `hours-misses.jsonl` (up to 5 samples of Maps panels where no hours were read, for when Maps
  changes its layout). The last two weeks are kept.

The service account in `gcp-creds.json` (repo root) has edit access to the sheet. Override it with
`GOOGLE_SERVICE_ACCOUNT_FILE`, and the sheet with `US_CONQUEST_SHEET_ID`.
