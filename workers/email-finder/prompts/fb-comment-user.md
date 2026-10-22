# USER PROMPT — one Facebook post in, one comment out

Fill the six marked blocks. Everything above `BEGIN POST` is context; the post itself goes at the bottom. If a block is unknown, write `unknown` — do not delete the label.

---

## CONTEXT

- **Market:** `<<< MARKET — US or UK >>>`
- **Group:** `<<< GROUP NAME — and what kind of group it is: owners / martial arts / local community >>>`
- **Who wrote the post:** `<<< owner / instructor / manager / parent / unknown >>>`
- **Our standing in this group:** `<<< member since when, whether we have posted before, whether anyone there knows us >>>`
- **Tone to hit:** `<<< e.g. dry and practical / warm but blunt / short and unbothered >>>`
- **Length:** `<<< 60-110 words, default >>>`

## THREAD STATE

- **Have we already commented on this post?** `<<< no / yes: how many times >>>`
- **Is a CTA still unused on this post?** `<<< yes / no — if no, write the comment without any CTA >>>`
- **Our earlier comments on this post (do not repeat a phrase or a CTA):**

```
<<< paste them, or "none" >>>
```

## FACTS WE MAY CITE

Only these numbers may appear as fact. Anything not listed must be asked as a question or left out.

```
<<< e.g. "our answered-call rate went from ~50% to ~90% after 4-9pm cover";
     "average student stays 14 months at $165/mo";
     "we mystery-called 11 schools in our county at 6:40pm, 6 rang out" >>>
```

## DO NOT USE

```
<<< phrases already worn out this week, e.g. "voicemail is where students go to die" >>>
```

## TWO THAT WORK

> Price on the phone is a trap you set for yourself. We stopped quoting it. Whoever answers says the first class is free, asks the kid's age, books a time. Cost gets discussed on the mat after they have watched their kid smile. Our answered rate went from about half to nearly all of it once someone other than me picked up between four and nine. DM me "price script" and I'll send the three lines we use, plus what to say when they push.

> Ring your own school at 6:40 on a Tuesday and listen to what a parent gets. Most owners have never done it, and most of them hear a voicemail. You are not short of enquiries. You are short of someone to answer them, and that is a cheaper problem than more ads. I have rung a lot of schools at that hour; the ones that answer are not better at karate. DM me "ringout" and I'll send the test — the reason it lands is not the recording.

## ONE THAT DOES NOT

> As a leading provider of AI receptionist solutions for martial arts schools, we offer 24/7 answering starting at $497/month, book a free demo today! 🔥

Rejected because: it names a product, a price, a company, a link-shaped CTA, an emoji, an exclamation mark, and answers nothing.

---

## THE POST

**Author wrote:**

```
<<< PASTE THE FACEBOOK POST OR COMMENT HERE, VERBATIM — keep the typos >>>
```

**If this is a reply to a specific comment, paste that comment here and set mode to `thread_reply`:**

```
<<< THREAD COMMENT, or "none" >>>
```

---

## TASK

Write the comment now, following the system prompt exactly.

Constraints, repeated because they matter:

- 60–110 words (`thread_reply`: 40–90).
- Four beats: hook, answer, earned aside, curiosity CTA.
- No price, no link, no product name, no emoji, no exclamation mark, no hashtag, no all-caps.
- Match the market's spelling and currency.
- The CTA names one concrete thing and withholds why it works — one closing sentence, at most 24 words — and only if a CTA is still available on this post.
- If this post should not be commented on at all, return `"action": "skip"` with a one-line reason instead of writing anything.

Return JSON only:

```json
{
  "action": "comment" | "skip",
  "mode": "public_comment" | "thread_reply" | "skip",
  "comment": "the exact text to paste",
  "word_count": 0,
  "hook_used": "",
  "answer_claim": "",
  "pitch_line": "",
  "cta_keyword": "",
  "cta_used": true,
  "market_spelling": "US",
  "risk_flags": [],
  "skip_reason": "",
  "dm_followup": ""
}
```
