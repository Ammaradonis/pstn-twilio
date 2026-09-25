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

Browser regression coverage is in `apps/web/e2e/softphone.e2e.test.ts`. It uses
the production-built UI at a mobile viewport with the real browser clipboard,
but intercepts API traffic and substitutes the voice SDK so no paid calls are
placed. It covers UK paste-to-call, ambiguous clipboard input, duplicate paste,
decline recovery, manual Answer, recording opt-in, and microphone switching.
It does not verify physical Galaxy microphone routing or live PSTN audio.
After building the web app, run in PowerShell with installed Google Chrome:

```powershell
$env:E2E_BROWSER_CHANNEL = 'chrome'
pnpm --filter @pstn-twilio/web exec playwright test e2e/softphone.e2e.test.ts --project=chromium --workers=1 --reporter=line
```

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

# Signaling recovery and unanswered calls (31000 / 31005 / 31009)

The September 25 callback audit includes a UK `NO_ANSWER` call to the destination
ending 3940 (`CA99fa4f546e94fcaa0d3046022663ad0a`) and successful UK calls. The
later calls to the destination ending 0626 instead returned Twilio 13224,
`invalid phone number`. These outcomes do not establish a broken outbound URL.

SDK 2.18.5 `Call._onHangup` can wrap a gateway error as `ConnectionError` (31005).
The frontend now inspects `originalError` and the HANGUP context, rather than
starting device recovery for every call-level 31005. After an outbound call
ends, a bounded lookup of its authorized intent retrieves the callback-backed
outcome. Confirmed no-answer/busy outcomes are notices; unconfirmed generic
errors retain their details without guessing that TwiML configuration is wrong.
Late results from a previous call or number cannot change a new call's state.

Genuine transport failures retain SDK recovery while a call is active. Idle
stalled devices are replaced after eight seconds, rotating the configured edge
order. A thirty-second overall watchdog ends the application retry loop and
shows a manual **Reconnect voice** button on Dial and Answer. Reconnection never
automatically redials a destination or destroys an active/incoming call. Voice
setup requests have timeouts, and registration uses the SDK's real
`registering`/`registered` events (`reconnecting`/`reconnected` belong to Call).

The hook and Chrome browser tests cover gateway HANGUP wrappers, callback-backed
no-answer results, prolonged outages, manual recovery, edge rotation, late
events, pending-call transport closure, and preserving active-call controls.
Network/VPN/carrier failures can still prevent a connection; browser tests use
simulated signaling and do not claim a live Galaxy radio/network test.

References: [31000](https://www.twilio.com/docs/api/errors/31000),
[31005](https://www.twilio.com/docs/api/errors/31005),
[31009](https://www.twilio.com/docs/api/errors/31009),
[Device options and events](https://www.twilio.com/docs/voice/sdks/javascript/twiliodevice).
