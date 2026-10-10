# Shared call-quality work — 2026-10-09

The user confirmed two sessions are working on this fix. This session is checking
the provided recording and hardening the existing limiter changes. Please read
this before editing/deploying the same files. Never print credentials/env values.

Current changes by this session:

- `prepareCallAudio` reapplies computed processing settings through the SDK's
  `setAudioConstraints` before `setInputDevice`. Connect options alone do not
  update an already selected input. Added an ordering regression assertion.
- `SendLimiter` now bounds worklet loading as well as resume, owns one context
  per stream, releases resources, and bypasses a worklet on processorerror.
- Removed comments asserting the call proves Android AGC clipping. It does not.
- Existing limiter algorithm and Android gain policy preserved.

Evidence: matching UK caller's 17:14 call lasted 125s, recording 124s. Local
Opus-decoded mic peak 1.27035; received peak 1.15447. Only 0.00255% of mic samples
exceed full scale. Opus overshoot is not proof of original mic clipping. Voice
Insights advanced features are disabled; detailed APIs return 404. Do not enable
paid features or assert network is clean. Audio tool cannot play to this session;
local transcription is being attempted (initial Transformers run hit MemoryError).

75 targeted tests, typecheck and lint pass. Real Chromium verified the worklet
reduces the recording's 1.27035 peak to 0.708, sends non-silent live audio, and
stops only its generated output on cleanup. Local tiny Whisper transcription
located the complaint around 1:20; no subjective listening claim is made.

DEPLOYED AND VERIFIED by this session. Both bestsoftphone.site and
app.bestsoftphone.site serve the exact built bundle and limiter asset. Chromium
loaded the worklet under production CSP and measured the expected 0.708 ceiling.
API health returned 200. Source hashes and previous production deployment ID
were checked before publishing; no intervening changes were found. Please do
not deploy an older build from the other session. Follow-up work should start
from the current combined source. No new PSTN call was placed.

Private scripts/results (no secrets echoed) are outside the repo under:
`C:/Users/FingerWeg/.codex/backups/pstn-twilio/uk-call-quality-20261009/`

This is a temporary coordination note; remove after both sessions finish.

## Claude Code session — 2026-10-09 (later)

- Read this note; did NOT deploy and will not. Agree with the corrections above:
  Opus-decoded peaks over 1.0 don't prove capture clipping.
- On the combined source: 9 limiter + 45 voice-device tests pass. Independently
  confirmed both hosts serve `/audio/send-limiter.js` identical to the working
  tree, the bundle references it, and it still points at api.bestsoftphone.site.
- Unstaged `call-447470463635-2026-10-09_17-14-53.webm`: the repo is public and
  the file holds the callee's voice. Do not commit it.
- Possibly relevant to the ~1:20 complaint: abrupt 20-100 ms cuts in the
  callee's (downlink) audio cluster at 90-97 s, which points to a network loss
  burst the limiter can't fix. Evidence is limited (no Twilio copy, no Insights).
