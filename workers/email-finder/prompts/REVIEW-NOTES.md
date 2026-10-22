# Facebook comment prompts: source review and usage

Reviewed on 2026-10-22 against the numbered corpus at
`C:\Users\FingerWeg\CascadeProjects\matboss.online\biz-legacy-for-copy`.
All files `1.txt` through `83.txt` were processed: 226,752 words total, no missing
numbers. The local source inventory and hashes are in
`../../../.cache/fb-prompt-review/source-manifest.json`.

## Use with DeepSeek

1. Put `fb-comment-system.md` in the system message.
2. Fill `fb-comment-user.md` for each post or individual comment. Include real
   service capabilities, relevant group rules, and previous replies in the thread.
3. Read the returned `comment` before posting. The returned `dm_followup` contains
   the promised additional help and is a separate draft to use when requested.
4. For another reply on the same post, include the parent post, target comment,
   and your previous replies. Set CTA availability to no after its first use.

The JSON fields remain compatible with the existing Facebook worker. Unknown
group standing now defaults to `unknown`, rather than claiming past participation.
No live DeepSeek generation or Facebook posting was performed for this review.

## Source principles used

The synthesis emphasizes diagnosis and economics (13–14, 53, 79), listening and
owner vocabulary (16, 44–45, 73, 80–81), practical outcomes and buyer motivation
(18, 25, 30, 42, 65), reliable delivery (20, 35, 38, 59), supported evidence
(15, 31, 67, 71–72, 77–78), execution (43, 54–55, 57, 75–76), and curiosity with
a real payoff (56). The entire corpus informed the review; illustrative stories
and numbers were not adopted as the user's biography or verified customer results.

File 56 supplies the central approach: give substantial public value, then leave
one specific question whose additional answer can actually be delivered. The
prompts apply that through a useful public answer and a complete DM follow-up,
without fabricated mysteries, personal audits, or case studies.

## Address coverage and execution status

A fresh read of U.S. Conquest and The Official UK accounted for all 28,104 rows
across 51 tabs. Of these, 27,965 had usable addresses and 139 had no address.
The generated plan maps every usable address to at least one localized query:
49,083 local queries plus 14 national queries, with zero usable addresses uncovered.
Repeated places can share a query while retaining coverage of each source row.

This is search-plan coverage, not evidence that every query has run or that a group
exists for every location. The group registry reported zero searches, joins, and
outreach actions. No group actions were launched in this review. Missing-address
rows require source data before address-based searches can be generated for them.

The existing Android and Facebook modules were inspected. Live group discovery,
membership, engagement, and outreach have not been validated by these prompt
checks; following everyone who comments or likes is not established as complete.

Validation: 65 existing prompt-rendering, text-checking, and vocabulary tests
passed. These tests do not establish the factual quality of future model outputs.
