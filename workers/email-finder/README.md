# Email finder worker

Runs on your PC. When you pick a spreadsheet tab on the Dial page, the API
queues every row without an email; this worker researches them in the
background and the API writes the results into the tab's `email`,
`emailType`, `emailSource`, `decisionMaker` and `contactForm` columns.

For each school it tries, cheapest first:

1. The school's website: home, contact, about/team/instructor and privacy
   pages (JavaScript-only pages are rendered in headless Chrome).
2. Brave search by name + town: snippets from Google listings, public
   Facebook/Instagram pages and directories; finds the website when the sheet
   has none or only a Facebook page.
3. Martial-arts directories, federations and tournament listings for the
   school's style and country (from `email-hunt.txt`, in `sources.py`).

spaCy (`en_core_web_sm` + martial-arts honorifics) works out who runs the
school and whose address each email is; addresses are checked for valid
syntax and a domain that receives mail (MX). It reads only public pages,
follows robots.txt and identifies itself; it does not log in anywhere.

## Setup (once)

```powershell
cd workers\email-finder
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python -m spacy download en_core_web_sm
.\install-autostart.ps1      # start at Windows logon
.\start-email-finder.ps1     # start now
```

Needs `EMAIL_FINDER_WORKER_TOKEN` and `BRAVE_API_KEY` in the repo's root `.env`.
Optional: `EMAIL_FINDER_CONCURRENCY` (3), `EMAIL_FINDER_BRAVE_DAILY_LIMIT` (3000
searches/day), `EMAIL_FINDER_USE_BROWSER` (1).

Log: `.cache\worker.log`. Stop: end the `pythonw.exe` process running
`email_finder.worker`; unfinished rows return to the queue after 20 minutes.

## Checking quality

```powershell
.venv\Scripts\python scripts\evaluate.py "..\..\Texas.csv" --rows 40 --seed 101
.venv\Scripts\python scripts\debug_row.py "..\..\Texas.csv" "school name"
.venv\Scripts\python -m pytest -q tests
```
