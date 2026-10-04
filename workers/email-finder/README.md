# Local email finder

Selecting a spreadsheet tab on any Dial page creates the output columns and
queues every named row without an existing email. The worker runs on this PC,
below normal CPU priority, with two rows at a time by default. Calls do not
depend on the worker.

## Discovery and ranking

- Read the supplied website and contact, about, instructor, team and policy
  pages. Render JavaScript pages when needed.
- Decode mailto, visible and obfuscated addresses, JSON-LD and Cloudflare email
  protection. A dedicated arithmetic email-reveal form can be answered without
  submitting a contact message.
- Search Google first when both its API key and Programmable Search Engine ID
  are configured. Otherwise use Brave. The user's `BEAVE_API_KEY` is a Brave
  key alias, sent only to Brave's documented endpoint.
- Rows with nothing to go on (no website, no Facebook/Instagram, nothing from a
  listing) are searched on free Google first, in headless Edge (or Chrome) with
  its own profile in `.cache/google-profile`, following
  `Google-search-engine-configuration-files/GOOGLE-FREE-SEARCH.txt`. That pass
  adds Google-only queries (free-mail addresses next to the name, the phone
  number on its own, owner mentions, the street) and reads any Facebook or
  Instagram profile it turns up. Brave keys are used only if it finds no
  address. Google no longer serves results without JavaScript, so the txt file's
  plain-HTTP recipe is only re-probed weekly. If a `cookies.txt` export is
  present, its google.com cookies (and nothing else in it) sign that browser in
  to the user's Google account, once per new export. Delete
  `.cache/google-profile` to sign it out.
- Free Google failures are told apart, because treating them alike used to hand
  the whole sheet to Brave:
  - Google blocked (CAPTCHA, "unusual traffic", 429) is never retried or solved.
    Free search pauses — 30 minutes, doubling to 8 hours — and Brave serves rows
    until it lifts.
  - A failure on this side (a slow page load, a browser shut down mid-query, an
    unrecognised layout) is retried once on a fresh browser and never pauses
    Google. If it still can't answer, the row is deferred and re-researched
    rather than charged to Brave, since these are exactly the rows the free pass
    exists for.
  - Google answering "no results" is an answer: the row is researched on Brave
    as normal.
- Each free search runs on its own Playwright driver, so the research browser's
  shutdown cannot abort a search mid-load. The driver is reference-counted, so
  lending it to another component never risks stopping it under a live page.
- Discover missing websites and business profiles using school name, street,
  town, phone and country. Cross-check discovered sites before trusting them.
- Read public Facebook/Instagram business profiles and Contact/About panels
  through a dedicated browser profile or an explicitly configured local CDP
  browser. Never open or close the user's calling tabs.
- Search every configured source group: general directories, country/style
  federations, association school registers, public tournament/team pages and
  owner references. Domains in the root `email-hunt.txt` are loaded at runtime.
  Private groups and membership databases are not harvested.
- Use spaCy's English NER, martial-arts honorific patterns and role proximity to
  distinguish named owners/head instructors, other staff and generic inboxes.
  A personal-looking Gmail address alone is not proof of ownership.
- Check syntax and DNS, including MX, null MX and RFC 5321 A/AAAA fallback.
  DNS timeouts defer research. This checks the domain, not whether an individual
  mailbox exists; no SMTP mailbox probing or SendGrid verification is used.

Writes include `email`, `emailType`, `emailSource`, `decisionMaker` and
`contactForm`. Existing addresses are preserved. Identity includes name, phone,
website and address, so ordinary sorting and duplicate rows are handled.
Changing identity fields during a run requires selecting the sheet again.

Search and page budgets are finite. No email or owner can be guaranteed.
Human verification/checkpoints are reported; the engine does not claim to
automatically solve arbitrary CAPTCHAs. Ordinary sessions, request spacing,
limited concurrency, caching and cooldowns reduce unnecessary challenges.

## Follow-up delivery

Sheet selection only researches contacts. Sending remains tied to the existing
post-call follow-up schedule and templates. If research is still running when a
call outcome is pushed, the follow-up waits for it.

When research finishes without an email but with a contact form, a due follow-up
is passed to this PC. The browser fills the real sender's name, email and caller
number, and places **subject + blank line + body** in the message field. Hosted
forms, Google Forms redirects, embedded forms and simple multi-step forms are
supported through their visible browser controls.

Unknown required choices, student/medical questions, consent, file uploads,
sign-in and human verification become manual review. No fabricated prospective
student answers are used. Optional unknown questions stay blank. Additional
truthful answers can be configured in ignored `form-answers.json` as
`{ "school.example": { "Exact field label": "Your answer" } }`.

Each form has a lease, then a one-use arm step immediately before Submit.
An explicit success message is required for SENT. An uncertain outcome is never
automatically submitted again. Review/cancel follow-ups in Settings → Google
Sheets & Gmail.

## Install and run

From this directory:

```powershell
.\setup-email-finder.ps1
.\install-autostart.ps1
.\start-email-finder.ps1
```

The API must include the `20261001180000_email_finder_recovery_and_forms`
migration and matching build. A pre-v2 API cannot supply research leases.

Settings load from process environment, then root `.env`, then root `env.txt`.
Credential values are never intentionally logged. Search API error URLs are
not logged, because Google puts its key in the query string.

| Setting                                                         | Purpose                                                                                         |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| EMAIL_FINDER_WORKER_TOKEN                                       | Shared secret with the API                                                                      |
| EMAIL_FINDER_API_BASE                                           | API origin; defaults to PUBLIC_BASE_URL                                                         |
| GOOGLE_SEARCH_API_KEY / GOOGLE_CLOUD_API_KEY                    | Google search key                                                                               |
| GOOGLE_SEARCH_CX / GOOGLE_CSE_ID                                | Google search-engine ID; OAuth client ID is not this                                            |
| BEAVE_API_KEY / BRAVE_API_KEY                                   | Brave search fallback                                                                           |
| EMAIL_FINDER_GOOGLE_DAILY_LIMIT                                 | Google request ceiling, default 100                                                             |
| EMAIL_FINDER_GOOGLE_FREE                                        | Free Google before Brave: `bare` rows only (default), `all` rows, or `off`                      |
| EMAIL_FINDER_GOOGLE_FREE_DAILY_LIMIT                            | Free Google searches a day, default 150, 6-15 seconds apart                                     |
| EMAIL_FINDER_GOOGLE_COOKIES                                     | cookies.txt export that signs free Google in; default repo-root `cookies.txt`, `off` to disable |
| EMAIL_FINDER_BEAVE_DAILY_LIMIT / EMAIL_FINDER_BRAVE_DAILY_LIMIT | Per-key Brave ceilings, default 300 each; identical keys share a ceiling                        |
| EMAIL_FINDER_CONCURRENCY                                        | Parallel rows, default 2, maximum 4                                                             |
| EMAIL_FINDER_PER_HOST_DELAY                                     | Request spacing, default 1.5 seconds                                                            |
| EMAIL_FINDER_MAX_SITE_PAGES                                     | Per-school page budget, default 10                                                              |
| EMAIL_FINDER_ROW_TIMEOUT                                        | Time limit per row, default 900 seconds                                                         |
| EMAIL_FINDER_USE_BROWSER                                        | Set 0 to disable browser research and form delivery                                             |
| EMAIL_FINDER_BROWSER_CDP_URL                                    | Optional local browser debugging endpoint                                                       |
| EMAIL_FINDER_CHROME_PROFILE_PATH                                | Optional dedicated automation profile                                                           |
| EMAIL_FINDER_SENDER_NAME / EMAIL / PHONE / COMPANY / WEBSITE    | Optional truthful sender fields; use the EMAIL*FINDER_SENDER* prefix for each                   |

Google's API requires both a key and an engine ID and is unavailable to new
customers; existing access is scheduled to end on January 1, 2027.
See [Google's API overview](https://developers.google.com/custom-search/v1/overview)
and [Brave's API reference](https://api-dashboard.search.brave.com/api-reference/web/search/get).

## Social session setup

The main Chrome profile cannot reliably be automated while Chrome is running.
A normal browser login is not automatically available to Playwright.
See [Playwright's profile restrictions](https://playwright.dev/python/docs/api/class-browsertype).

```powershell
# Attempts a headless login once using the local Facebook/Instagram credentials.
.venv\Scripts\python scripts\social_session.py

# Run this explicitly if a manual login/checkpoint is needed.
.venv\Scripts\python scripts\social_session.py --interactive
```

Close/stop the research worker before preparing its dedicated session. Session
cookies stay in the ignored local `.cache/browser-profile` folder. Do not share it.

## Recovery, limits and evaluation

SQLite caches searches and pages, stores daily request reservations and keeps an
outbox of completed research/results awaiting API acknowledgment. The API
recovers unfinished sheet writes after restart, rejects stale leases and
reschedules transient DNS/search failures. Search allowance resets at UTC
midnight. Work paused in the Dial page stays paused.

```powershell
.venv\Scripts\python -m pytest -q tests
.venv\Scripts\python scripts\audit_samples.py
.venv\Scripts\python scripts\evaluate.py "..\..\Texas.csv" --rows 25 --seed 7
```

The audit chooses website, social-only and no-website rows from both supplied
CSVs. Results are in ignored `reports/request-audit.json`. Samples contain no
verified owner labels, so measured coverage is not a precision/accuracy score or
supervised model training. Browser submission tests use intercepted fixtures
and send no live messages.

Logs: `.cache/worker.log`. End only the `email_finder.worker` Python process to
stop; another instance is prevented with a process lock.

## Large-sample calibration

Collect a reproducible sample from each CSV, then calibrate against the saved
evidence. Collection reads public websites with per-host pacing, DNS validation
and bounded concurrency. It disables browser sessions and paid search and never
sends messages or submits forms. The input hashes and exact random sample are
saved in a manifest; each completed row is checkpointed for resuming.

```powershell
.venv\Scripts\python scripts\training_corpus.py --rows 1200 --seed 20261001 --pages 6 --concurrency 24
.venv\Scripts\python scripts\training_corpus.py --rows 1200 --seed 20261001 --pages 6 --concurrency 24 --retry-errors
.venv\Scripts\python scripts\tune.py reports\training-20261001 --apply
```

On a memory-constrained PC, use `--concurrency 16 --nlp-processes 1`.
`--resume-timeout 300 --retry-errors` allows slow rows more time while preserving
the original sample. Execution settings and retries are logged alongside the
corpus. CPU work runs below normal priority on Windows.

The sweep is entirely offline, including DNS. It uses the production scoring
implementation and frozen domain-validation results. Related phone numbers,
website domains and social profiles stay together across training, validation
and test splits. Training selects among 81 parameter sets; validation and final
holdout checks gate adoption without further parameter searches. Without improvement, existing
default weights are retained. `--apply` writes the validated runtime weights to
`email_finder/scoring-parameters.json`, loaded when an Engine is constructed.

These CSVs contain no verified email or owner labels. Calibration uses explicit
and corroborated website evidence as weak labels. Coverage and evidence scores
are **not email accuracy, ownership accuracy, or mailbox-deliverability scores**.
The experiment measures website-only discovery and frozen candidate ranking;
it does not measure the full browser/search workflow. Reports include every
sampled row, collection failures, per-country results and split assignments.
See [the October 2026 calibration results](CALIBRATION.md) for the completed run.

The workbook cleanup runs separately from the repository root:

```powershell
workers\email-finder\.venv\Scripts\python scripts\dedup_us_conquest.py --apply
```

It keeps the first normalised phone occurrence within each tab, supports both
`phoneNumber` and the legacy lead-export `number` header, and preserves blank
phones. Country codes and extensions remain distinct. Workbook metadata and
editable grid data for changed tabs are backed up locally before deletion;
every tab is read again and verified. OAuth credentials load from environment
or ignored `.cache/sheets-oauth.json`; no credentials belong in the script.
