# USER PROMPT — One owner question or comment

Write one reply using the system prompt. Fill the marked fields; write `unknown` when necessary. Copy only the returned `comment` field into Facebook. Keep `dm_followup` for delivering the promised resource if someone asks.

## Context

- Market: <<< MARKET — US or UK >>>
- Group and audience: <<< GROUP NAME — and what kind of group it is: owners / martial arts / local community >>>
- Author's known role: <<< owner / instructor / manager / parent / unknown >>>
- Our actual standing in this group: <<< member since when, whether we have posted before, whether anyone there knows us >>>
- Tone: <<< e.g. dry and practical / warm but blunt / short and unbothered >>>
- Original comment length: <<< 60-110 words, default >>>

## Facts and constraints we may use

Include our real role; services we actually provide; verified experience or results, if any; a ready-to-send resource, if any; and relevant group rules. Do not copy example numbers unless they are true. If no resource is supplied, draft a useful checklist or script in `dm_followup` before promising it. Proposed checks and numbered steps are allowed; invented performance statistics are not.

```text
<<< e.g. "our answered-call rate went from ~50% to ~90% after 4-9pm cover";
     "average student stays 14 months at $165/mo";
     "we mystery-called 11 schools in our county at 6:40pm, 6 rang out" >>>
```

## Thread state

- Have we already commented on this post? <<< no / yes: how many times >>>
- Is the thread's single CTA still available? <<< yes / no — if no, write the comment without any CTA >>>
- Our earlier comments and replies:

```text
<<< paste them, or "none" >>>
```

- Phrases to avoid repeating:

```text
<<< phrases already worn out this week, e.g. "voicemail is where students go to die" >>>
```

## Owner's post

```text
<<< PASTE THE FACEBOOK POST OR COMMENT HERE, VERBATIM — keep the typos >>>
```

If replying to a specific comment, paste it below and set mode to `thread_reply` (40–90 words). Keep the original post above as context. Answer the specific commenter rather than repeating the original advice.

```text
<<< THREAD COMMENT, or "none" >>>
```

## Task

Write a specific hook, a useful answer, an optional earned aside based on real facts, and one curiosity CTA if permitted and unused. Leave the reader with a useful action even if they never message us. The CTA offers a concrete next step and a reason to want it, not a vague secret or a withheld answer to their main question. Deliver that next step in `dm_followup`; do not invent results or personal experience.

Return the system prompt's JSON object only, with `"action": "comment"` or `"action": "skip"`. No explanation outside the JSON.
