# UK softphone

The UK line `+447458904436` is assigned to the same owner as the US lines.
It supports voice and SMS; Twilio reports no MMS capability.
Its number ID is `c0af701e-a77c-4e14-baa6-96ef2ebf9934`.

Incoming calls use the existing manual-answer browser flow, with a rejecting
fallback, no voicemail, and inbound recording disabled until enabled on Answer.
The shared outbound TwiML application supplies the selected number as caller ID.

On this number's Dial page, Paste and direct destination-field paste both
normalize UK national/international formats and start calling. They skip the
repeat-dial lookup/prompt. Microphone permission is still required. Incomplete
or ambiguous text does not start a call. Explicit international country codes
are preserved. The US lines retain their existing US formatting and repeat-call
behavior.

UK parsing uses `libphonenumber-js/max` numbering-plan metadata, covering
`020…`, `07…`, `0044…`, and `+44 (0)…`. Updating that dependency refreshes the
numbering-plan rules. Examples and business-listing paste cases are tested in
`packages/shared/src/phone.test.ts` and `apps/web/src/pages/dial.test.tsx`.

`apps/api/scripts/import-uk-softphone.ts` audits the newest UK number by default;
`--apply` imports/configures it. It checks ownership against the existing active
lines and checks UK dialing permission. It does not purchase numbers or modify
the US lines. Use `scripts/inbound-policy.ts` in audit mode to check all lines.

# Declined calls (31603)

Twilio defines 31603 as SIP 603 Decline. On September 24, 2026 at 18:43 and
18:46 UTC, the stored callbacks for outgoing calls to the US destination ending
5064 showed SIP 603 with status `busy`. The Twilio account was active when
checked. A destination or carrier can continue declining calls.

The softphone displays a declined-call notice, releases call resources, and
keeps registration available for the next call. Old call events cannot close a
new call. Regression tests also cover nested SDK errors, failed connection
cleanup, and switching Automatic audio during a live call.

Reference: [Twilio 31603](https://www.twilio.com/docs/api/errors/31603).
