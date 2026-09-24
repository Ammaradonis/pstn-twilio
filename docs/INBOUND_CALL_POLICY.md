# Incoming calls and microphone selection

Both active numbers use the browser inbound webhook. The first TwiML verb is
`Dial answerOnBridge="true"`: the caller keeps ringing until the browser user
presses Answer. After 30 seconds, rejection, or failure, the dial-complete
webhook returns `Reject` without a greeting or voicemail. Completed calls end
with `Hangup`. Unknown/inactive numbers and error fallbacks also return `Reject`.
Legacy voicemail URLs remain callable but cannot create recordings.

This avoids answering missed calls and the resulting voice-minute and voicemail
recording charges. Number rental and previously stored recordings are independent
of this policy. Verify final call statuses and prices in Twilio after an actual
missed-call test; signed webhook probes do not exercise PSTN billing.

References: [Twilio Dial](https://www.twilio.com/docs/voice/twiml/dial#answeronbridge),
[Twilio Reject](https://www.twilio.com/docs/voice/twiml/reject).

## Recording

The Answer page has a separate per-number Record call switch. It defaults off,
is saved on the server, and applies to calls that begin ringing after the change.
It is disabled while a call is ringing/active; it does not start/stop recording
mid-call. Only the boolean `tags.recordInboundCalls === true` enables dual-channel
recording from answer. The Dial page's outbound recording setting is independent.

## Microphones

Dial and Answer share a remembered microphone choice. Automatic retains the
existing Android earpiece preference, except when a headset is connected. An
explicit choice uses the browser's exact device ID. Live switching uses the
Voice SDK's input-device API; failure leaves the previous selection visible and
shows an error. A missing selected device must be reselected or reset to Automatic.
Live input capture is released when the call ends.

Chrome on Android commonly exposes communication routes named Speakerphone and
Headset earpiece. These are not reliable identifiers for physical microphone
locations. The Galaxy A36's top/bottom capsules cannot be promised as independently
selectable from a web app. The UI lists actual browser devices without inventing
a top/bottom mapping. Physical routing must be checked on the handset.

## Rollout and verification

Deploy the API and web build, then run:

```powershell
pnpm --filter @pstn-twilio/api exec tsx --env-file=../../.env scripts/inbound-policy.ts
pnpm --filter @pstn-twilio/api exec tsx --env-file=../../.env scripts/inbound-policy.ts --apply
```

Apply resets inbound recording to off for every active owned voice-capable Twilio
number and configures browser routing plus a rejecting fallback. It clears a
Voice Application override and refuses numbers with SIP trunk routing or missing
ownership. SMS and outbound call configuration are untouched. Settings can block
inbound calls or ring the browser; automatic AI answering cannot be enabled.

On each number, check no-answer, browser rejection, offline browser, and caller
hangup before answer. Confirm zero call duration/voice price and no new recording
in Twilio. Answer once with Record call off, then enable it before a subsequent
call and confirm recording starts only after answer. Turn it off afterwards.
On the Galaxy A36, grant mic permission, refresh microphones, and test each listed
route on Dial and Answer, including a live switch and headset removal.
