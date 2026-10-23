# The Status cell's three sentences

After a call, the Dial page pushes a status into the sheet's `Status` column:

```
Voicemail, owner is Coach Mike, <three personalised sentences>, from: 02045726501, time: 5:45pm on a Friday
```

The three sentences come from two separate pieces of work.

## 1. The facts (Python, `workers/email-finder`)

`email_finder/profile.py` reads the pages a visitor reads — the school's home
page, its classes/about/contact pages, and its Facebook or Instagram profile when
the site has no programmes of its own — and extracts only what the page actually
says:

| fact          | example                                     |
| ------------- | ------------------------------------------- |
| `programs`    | `kids karate`, `adults jiu jitsu`, `karate` |
| `audiences`   | `kids`, `adults`, `beginners`               |
| `styles`      | `karate`, `jiu jitsu`                       |
| `instructors` | `Sensei John Smith`                         |
| `events`      | `gradings`, `summer camps`                  |
| `hours`       | `Tuesdays and Thursdays 5–6pm`              |
| `days`        | `Tuesday`, `Thursday`                       |
| `times`       | `5–6pm`                                     |
| `offers`      | `a free trial class`                        |
| `since`       | `1998` (or `20 years`)                      |

Precision is the rule: a programme needs its audience in the **same sentence**
("kids" somewhere and "karate" somewhere else proves nothing), an instructor
needs a teaching role next to the name (spaCy supplies the people, `nlp.py`), and
a number only becomes a class time when it is written as one. A row whose pages
say nothing specific gets no profile rather than a vague one.

`Engine.profile()` in `engine.py` fetches those pages (from the same cache the
address finder fills) for finder jobs in `PROFILE` mode. The facts are stored per
finder row, next to the sheet row they came from.

## 2. The sentences (TypeScript, `apps/api`)

`apps/api/src/sheets/status-sentences.ts` holds a bank of sentence _structures_
grouped by what the call actually did:

| status tags                                                                             | angle            |
| --------------------------------------------------------------------------------------- | ---------------- |
| Rang out · Voicemail · Line is busy · Voicemail is full · Not available · Stayed silent | `missed`         |
| Rang out but voicemail box hasn't been set up yet                                       | `no-voicemail`   |
| Has a receptionist · Has an answering service                                           | `gatekeeper`     |
| Not interested · Hung up on me                                                          | `declined`       |
| Out-of-service number                                                                   | `dead-line`      |
| Has an AI                                                                               | `answered-by-ai` |
| Handles calls himself                                                                   | `owner-answers`  |
| Booked a demo                                                                           | `booked`         |

Each structure lists the facts it needs, so the composer only uses structures the
profile can fill: three sentences when the pages support three, fewer (with a note
in the panel) when they do not. The same row and statuses always produce the same
sentences, and different rows prefer different structures.

### Where the structures come from

The bank's voice is taken from the `hustle/` transcripts in the project root —
analyses of hustling and sales material, rewritten for selling an AI phone agent
to martial arts schools. Their argument is always three beats, and so is every
structure:

1. **one specific, checkable observation about their school** — "I rang on
   Tuesday, right around your kids karate class";
2. **the consequence of how the call actually went** — "so this note is shorter
   than the voicemail", "the front desk could not tell me your times", "the number
   on your page is out of service";
3. **an understated next step** — "I will try once more", "no pitch, I will leave
   it there", "that is all".

No adjectives, no promises, no numbers that are not in the profile, no claim of
results, and no sentence that would be false for a school we know nothing about.
That is why the sentences read like a person who looked at the site rather than a
mail merge — and why a sparse profile returns two sentences instead of three.

## Adding a sentence

Add a structure to the right angle in `SENTENCE_BANK`, list the facts it needs in
`needs`, keep it one sentence under 190 characters, and use only the slots in
`Slot`. The composer will use it whenever those facts exist. Run
`pnpm --filter @pstn-twilio/api exec vitest run src/sheets/status-sentences.test.ts`
— it checks every tag still gets three sentences from a rich profile.
