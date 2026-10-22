# Facebook groups for martial arts school owners

A second Android worker, built on the same chassis as the Instagram one, that
finds Facebook groups from the address book, joins them slowly, engages like a
person, and answers owners' questions with a comment worth reading.

It exists because the Instagram worker already proved the hard parts: driving a
real phone over `adb`, reading a screen it cannot guess at, pausing itself when
Meta objects, and pacing actions on distributions instead of fixed intervals.
Those parts are reused (`android.Galaxy`, `ambient.Gesture`, `cache.Cache`). What
is new is the part Instagram never did: **typing**.

```
addresses ─► localized searches ─► join queue ─► feed engagement ─► DMs
  fb_addresses      fb_vocab          fb_groups      fb_groups + fb_engage
                                                         │
                                                   fb_prompts (the two prompts)
```

---

## 1. The Instagram setup, for reference

`android.py` + `ambient.py` are the model. Their properties are worth naming
because the Facebook worker inherits every one of them:

| Property                    | How it is done                                                                                                                                 |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Reads, never guesses        | UiAutomator hierarchy parsed into `Node`s; every action is decided from a fresh dump, and an unreadable screen is reported, not tapped through |
| Retries reads, never inputs | `adb` drops off USB often enough that read-only commands retry; a tap that may have landed twice is worse than a missed one                    |
| One driver at a time        | A lock file shared by the worker and any probe script                                                                                          |
| Stops on the loudest signal | A challenge pauses the app for 12 h and the whole phone with it; a login screen pauses only that app                                           |
| Only exact labels           | In a menu that also holds Report/Hide/Unfollow, only "Interested" / "Not interested" are ever tapped                                           |
| Behaviour is a distribution | Beta-distributed session mood, fatigue decay, per-action cooldowns, log-normal dwell, three gesture archetypes (flick/drag/nudge)              |
| Caps are the real bound     | Per-hour and per-day counters in SQLite, all env-tunable, checked before the draw is honoured                                                  |
| Every action verified       | Like → is it selected? Follow → does it say Following?                                                                                         |

The Instagram session deliberately never types and never sends: no comments, no
messages. That is why its caps can be generous (180 likes/day). A worker that
comments needs a different posture.

---

## 2. Every address becomes a search

`fb_addresses.py` reads **both** workbooks, tab by tab, and turns every non-empty
row into a record — including rows it cannot use, which get a `reason` instead of
disappearing. Column detection mirrors `sheets.service.ts`: the same header
fallbacks, and the address rebuilt from separate city/state/zip columns exactly
as the API's `rowAddress` does.

Live count from `python scripts/fb_groups.py plan`:

```
addresses                 27,965     (U.S. Conquest 24,139 + The Official UK 3,826)
uncovered                      0
local searches            49,083
national searches             14
by tier        1: 11,550   2: 29,083   3: 8,450
```

`fb_vocab.py` collapses the addresses to **5,775 places** (US 5,102, UK 673) —
Facebook groups are named after towns, not schools — and every address belongs to
exactly one place. Each place draws phrases from a country-specific pack:

| Tier | US                                                                                                                                                            | UK                                                                                                            |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1    | `{city} martial arts`, `{city} business owners`                                                                                                               | same, UK spelling                                                                                             |
| 2    | `{city} small business owners`, `{city} karate`, `{city} gym owners`, `{city} community`, `{city} parents`, `{county} County business owners`                 | `{city} small business`, `{city} martial arts classes`, `{county} business owners`, `{postcode} martial arts` |
| 3    | `{city} taekwondo`, `{city} jiu jitsu`, `{city} mma`, `{city} moms`, `{county} County martial arts`, `{state} martial arts owners`, `{postcode} martial arts` | `{city} mums`, `{county} martial arts`, `{city} personal trainers`                                            |

A town with one school earns five phrases; a city with 129 earns all nineteen
(`phrase_budget`). The plan keeps a **ledger**: address → the phrases that search
its town. `coverage()` fails loudly if any usable address has no phrase behind it,
which is the test that keeps the "every single address" rule honest.

The 14 national seeds (`martial arts school owners`, `dojo owners`, `uk martial
arts instructors`, …) are held separately and are **never counted as coverage**:
they widen the net, they do not satisfy the rule.

Run order is tier 1 → 2 → 3 and is resumable: `queue_searches()` sorts by
(tier, schools covered, name) and skips anything already in the registry.

---

## 3. Finding and joining

`fb_groups.py` navigates by deep link (`am start -a VIEW -d … -p
com.facebook.katana`), not by tapping a search box that moves between releases.

Search results are parsed by **vertical geometry**, not resource ids: `bands()`
clusters nodes into cards by the gap between them, `longest_text()` takes the
card's name, and the members/privacy lines are matched by pattern. A card is only
a group if its name says so.

`score_group()` then decides, with reasons recorded:

- +30 martial-arts word, +25 owner/business word, +12 the phrase's town in the name
- +12 for 25k+ members, −12 for under 100
- −70 and `reject` for buy/sell, swap, marketplace, jobs, rentals, dating, memes
- consumer groups (parents, mums, families) are kept but classified
  `local-community`, because they are the audience, not the buyers

Join is verified: the control is tapped, the screen is re-read, and only
`Joined` / `Requested` is recorded as a success. Anything else is `failed` with
the reason, and a group is never joined twice.

---

## 4. Engagement: the rules, in one place

`fb_engage.py` is the Facebook analogue of `ambient.py` — pure decisions, seeded,
testable without a phone.

**What earns an action**

| Post                                                     | Like                         | Comment | CTA                  | Reply   | Follow |
| -------------------------------------------------------- | ---------------------------- | ------- | -------------------- | ------- | ------ |
| A question from an owner                                 | ✓                            | ✓       | if the post has none | up to 3 | ✓      |
| A pain statement ("we lost three families")              | ✓                            | ✓       | if unused            | —       | ✓      |
| A win / social post                                      | —                            | —       | —                    | —       | —      |
| Somebody's advert                                        | —                            | —       | —                    | —       | —      |
| A job post                                               | —                            | —       | —                    | —       | —      |
| Grief, illness, politics, a pile-on, safeguarding, legal | **skip, to the human queue** |         |                      |         |        |

**Why a comment is refused** — seven checks, in the order that costs least:
comments off · already commented · sponsored · sensitive/promo/hiring · too short
(< 60 chars) · too long (> 4,000) · another vendor · not a question or a problem ·
commented on this person in the last 7 days.

**Structure limits** (not pace limits): one comment per post, at most three
replies per post, each reply to a different person, one CTA per post thread, one
follow per author, one DM per person ever.

**Pace** — per hour / per day, halved for a young account (`warmup_factor`:
40 % under 7 days, 70 % under 14, 100 % after):

| Action  | /hour | /day |
| ------- | ----- | ---- |
| like    | 40    | 200  |
| comment | 5     | 18   |
| reply   | 8     | 28   |
| follow  | 5     | 25   |
| DM      | 6     | 20   |
| join    | 3     | 12   |
| search  | 12    | 60   |

Plus per-action cooldowns drawn per event (a comment waits 4–15 minutes after the
previous one), local quiet hours 01:00–06:00, and a 12-hour everything-stop after
a checkpoint. All env-tunable under `FB_GROUPS_*`.

**DMs need history.** `dm_eligible()` refuses unless the account has touched the
person twice, at least three days after the first touch, and not within a day of
commenting on them. The opener quotes something they actually wrote
(`dm_line`), because a message that could have gone to anyone is a blast.

---

## 5. The comment itself

Two files, and they are the deliverable as much as the code:

- [`prompts/fb-comment-system.md`](prompts/fb-comment-system.md) — persona, the
  four-beat comment, voice rules, the payout library, the CTA engine, hard bans,
  modes, self-check, JSON contract.
- [`prompts/fb-comment-user.md`](prompts/fb-comment-user.md) — the fillable
  per-post prompt: market, group, author, thread state, citable facts, phrases
  being rested, two examples that work and one that does not.

The four beats: **hook** (proves you read their post) → **answer** (the diagnosis
and the arithmetic, useful even if they never DM) → **earned aside** (first-person
proof, no product name) → **curiosity CTA** (one concrete artifact, mechanism
withheld).

`fb_prompts.py` renders the user prompt from a `CommentRequest`, calls DeepSeek
(`deepseek-chat`, JSON mode), and then runs `check()` — the gate every comment
must pass before it can reach a phone:

- word count in range (60–110; 40–80 for a thread reply)
- no link, no price, no emoji, no exclamation mark, no hashtag, no all-caps
- no "as an AI", no product name, no corporate vocabulary, no guarantee or fake deadline
- a CTA in the **last** sentence when the post has one available, with a keyword;
  no CTA when the thread already spent it; never "DM me for more info"
- no repeat of an earlier comment on that post, no phrase on the rest list

A failure is fed back once as a repair turn. A second failure is **not posted** —
it goes to the review queue with the reason. Nothing that fails the gate can be
typed, because `_type_and_submit` only ever receives text that passed.

`generate()` without `DEEPSEEK_API_KEY` returns both rendered prompts instead of
calling anything, so the same prompts can be run by hand in the DeepSeek app.
From the repo root, use the wrapper (it picks the worker's virtualenv and sets
`PYTHONPATH` for you — `python -m` from the root cannot import `email_finder`):

```powershell
# Render both prompts to workers\email-finder\tmp\facebook-comment-<stamp>.md
.\workers\email-finder\fb-comment.ps1 --post tmp\post.txt --market UK `
    --group "Martial Arts Instructors UK" --author owner `
    --fact "we ring our own line at 6:40pm every Tuesday"

# Render and call DeepSeek, then gate the answer
.\workers\email-finder\fb-comment.ps1 --post tmp\post.txt --market UK --run

# A reply to someone else's comment, and no file needed
.\workers\email-finder\fb-comment.ps1 --text "How do you price trials?" `
    --thread "Just put the prices on the website." --market UK
```

In PowerShell, a line continuation is a backtick, not `^` (that is cmd.exe), and
the backtick must be the very last character on the line.

---

## 6. Typing safely

`input text` is a shell command, so model prose goes through `sanitize()` first:
smart quotes normalised, newlines flattened (a newline would post half a comment),
`& | ; < > $ \` \\ " ' ! \* ? ( ) [ ] { } ~ ^`stripped, length capped at a word
boundary.`input_text_arg()`then turns spaces into`%s`.

After submitting, the screen is re-read: the comment must either appear
(`looks_published`, comparing a 40-character slice) or the composer must have
closed. A comment under 20 words is refused rather than posted.

---

## 7. Running it

The runner resolves its own imports, so it works from the repo root as long as it
is the worker's own Python:

```powershell
$fb = ".\workers\email-finder\.venv\Scripts\python.exe", ".\workers\email-finder\scripts\fb_groups.py"

& $fb addresses --refresh   # read both workbooks
& $fb plan                  # coverage + search plan
& $fb search --limit 20     # tier 1, first 20 per tier
& $fb search --join --limit 20
& $fb join --top 5
& $fb engage --groups 3
& $fb outreach --dms 5
& $fb review                # what a human should see
& $fb report                # registry + today's caps
```

Or `cd workers\email-finder` and use `.venv\Scripts\python scripts\fb_groups.py …`.

`--dry-run` prints the queue without touching the phone.

A sensible first fortnight, given the caps: plan, then ten searches a day
(≈ 7 minutes of phone time each run), joining what scores 45+, and only then
engaging one or two groups a day. Comments start at about five a day for a
14-day-old account and reach eighteen a day after that. Do not raise the caps to
go faster; that is the one change that turns a slow account into a banned one.

### Settings

| Variable                                                                           | Default | Meaning                                       |
| ---------------------------------------------------------------------------------- | ------- | --------------------------------------------- |
| `FB_GROUPS_ENGAGE`                                                                 | on      | master switch for the session                 |
| `FB_GROUPS_LIKE` / `_COMMENT` / `_REPLY` / `_FOLLOW` / `_DM` / `_JOIN` / `_SEARCH` | on      | per-action switch                             |
| `FB_GROUPS_COMMENT_PER_HOUR` / `_PER_DAY`                                          | 5 / 18  | etc. for every action                         |
| `FB_GROUPS_ACCOUNT_AGE_DAYS`                                                       | 90      | drives the warm-up factor                     |
| `FB_GROUPS_QUIET_HOURS`                                                            | `1-6`   | local, `off` to disable                       |
| `FB_GROUPS_AUTHOR_COOLDOWN_DAYS`                                                   | 7       | before commenting on the same person again    |
| `FB_GROUPS_DM_AFTER_DAYS`                                                          | 3       | history required before a DM                  |
| `FB_GROUPS_MAX_REPLIES_PER_POST`                                                   | 3       | replies under one question                    |
| `DEEPSEEK_API_KEY`                                                                 | —       | unset means "render the prompts, do not call" |

The phone itself is configured exactly as the Instagram worker's: `EMAIL_FINDER_GALAXY`,
`EMAIL_FINDER_GALAXY_SERIAL`, `EMAIL_FINDER_GALAXY_DAILY_LIMIT`, `EMAIL_FINDER_ADB`.

---

## 8. What can go wrong, honestly

- **The screen selectors are the weak point.** Group cards and comment bands are
  parsed by geometry, which survives Facebook changing resource ids but needs
  tuning against real dumps on the actual device. The first run should be
  `--dry-run`, then one search, then read the log: every parse is logged with the
  labels it saw (`_describe_screen`-style notes in `GroupVisit`).
- **Facebook's terms.** Automated engagement violates them. The caps, quiet
  hours, warm-up and human review queue exist to keep the account credible and
  the behaviour defensible, not to make it undetectable. Assume a checkpoint will
  eventually happen; the worker stops for 12 hours and asks you to clear it by
  hand.
- **A comment is permanent.** The gate catches prices, links, emoji and repeats.
  It cannot catch "this will annoy this particular group". The review queue, and
  the first week of reading every comment before it posts, is what catches that.
- **The DM promise has to be kept.** Every CTA offers a specific artifact. If
  nobody sends it, the comments become the exact spam they were written to avoid.
- **The offer facts are the corpus's, and they are illustrative.** Prices in the
  83 files range from $197 to $997; the prompts never publish a price. Before
  quoting any number as your own experience, make it true — the `FACTS WE MAY
CITE` block in the user prompt is the only place a number is allowed to come
  from.
