# Phase 8 Implementation Complete

## Summary

Phase 8 (Voice, WebRTC softphone, inbound call answering, outbound dialer, and call logs) is implemented end-to-end. The browser registers a Twilio Voice JS SDK Device against a short-lived Access Token; inbound PSTN calls to a Twilio number ring that browser tab via signed `<Dial><Client/></Dial>` TwiML; the dialer page places outbound PSTN calls through a signed TwiML App webhook with caller ID locked to the selected Twilio number; all status callbacks update the `calls` table and broadcast over Socket.IO so the call log updates in real time.

## What was implemented

### Backend (`apps/api/src/`)

- `voice/`
  - `voice.service.ts` — `issueToken` (Twilio Access Token + VoiceGrant), `getIdentity`, `getDeviceConfig`, `prepareOutbound` (ownership + voice-capability + E.164 validation), `ensureVoiceIdentity` (idempotent upsert).
  - `voice.controller.ts` — JWT-guarded `POST /voice/token`, `GET /voice/identity`, `GET /voice/device-config`, `POST /calls/prepare-outbound` with throttling on token mint.
- `calls/`
  - `calls.service.ts` — list (cursor-paginated, ownership-guarded), getOne, hangup (active-state only, Twilio + DB + audit + WS), addNote (audited).
  - `calls.controller.ts` — JWT-guarded `GET /numbers/:numberId/calls`, `GET /numbers/:numberId/calls/:callId`, `POST /calls/:callId/hangup`, `POST /calls/:callId/notes`.
  - `calls.mapper.ts` — `Call` row → `CallDto` and base64url cursor codec.
- `webhooks/`
  - `voice.controller.ts` — `TwilioSignatureGuard`-protected `POST /webhooks/twilio/voice/{inbound,outbound,status,fallback}`. Inbound and outbound fall back to a graceful `<Say><Hangup/>` if the handler throws so Twilio never sees a 500.
  - `voice.service.ts` — handleInbound (dedupe + persist + emit + `<Dial><Client/></Dial>`), handleOutbound (identity verification + caller ID + `<Dial callerId><Number/></Dial>`), handleStatus (dedupe + status / duration / price / parentCallSid / answeredAt / endedAt + emit), handleFallback.
  - `voice-status.mapper.ts` — Twilio raw → `CallStatus` enum (case-insensitive).
- `realtime/realtime.service.ts` — `callInboundRinging` + `callStatusUpdated` already wired in Phase 7, now produced by the voice webhooks and the calls service.

### Frontend (`apps/web/src/`)

- `hooks/use-voice-device.tsx` — full hook around `@twilio/voice-sdk`:
  - Browser-support check (`RTCPeerConnection` + `getUserMedia`).
  - Microphone permission detection via the Permissions API.
  - Token mint + `Device.register()`, with `tokenWillExpire` handling and a scheduled refresh 60s before expiry.
  - Connection state machine (`idle → pending → ringing → open → closed`).
  - Mute / unmute, hangup, accept, reject, with proper listener cleanup.
- `hooks/use-realtime-calls.ts` — listens to `call.inbound.ringing` + `call.status.updated`, upserts into the TanStack Query cache.
- `pages/answer.tsx` — readiness pills (WebRTC / registered / ready / mic), browser + permission warnings, incoming call card with Answer/Reject, in-call card with Mute/Hangup.
- `pages/dial.tsx` — readiness pills, E.164-validated input, 12-key dial pad, caller ID display, Call/Mute/Hangup/Clear with live state.
- `pages/calls.tsx` — call log table fed by TanStack Query, kept live by `useRealtimeCalls`, with hangup action.
- `lib/api-client.ts` — `api.calls.{list,get,hangup,addNote}` and `api.voice.{token,identity,deviceConfig,prepareOutbound}` wired up.

## API surface delivered

| Route                                         |
| --------------------------------------------- |
| `POST   /api/voice/token`                     |
| `GET    /api/voice/identity`                  |
| `GET    /api/voice/device-config`             |
| `POST   /api/calls/prepare-outbound`          |
| `GET    /api/numbers/:numberId/calls`         |
| `GET    /api/numbers/:numberId/calls/:callId` |
| `POST   /api/calls/:callId/hangup`            |
| `POST   /api/calls/:callId/notes`             |
| `POST   /webhooks/twilio/voice/inbound`       |
| `POST   /webhooks/twilio/voice/outbound`      |
| `POST   /webhooks/twilio/voice/status`        |
| `POST   /webhooks/twilio/voice/fallback`      |

## WebSocket events

| Event                  | Payload                       |
| ---------------------- | ----------------------------- |
| `call.inbound.ringing` | `{ numberId, call: CallDto }` |
| `call.status.updated`  | `{ numberId, call: CallDto }` |

## Tests

- `pnpm --filter @pstn-twilio/api typecheck` — clean.
- `pnpm --filter @pstn-twilio/web typecheck` — clean.
- `pnpm --filter @pstn-twilio/api test` — all suites passing. New Phase 8 coverage:
  - `webhooks/voice-status.mapper.test.ts` — every Twilio status + unknown sentinel + case-insensitivity.
  - `webhooks/voice.service.test.ts` — handleInbound (missing fields, unknown number, happy path TwiML shape + WS emit + webhook_events row), handleOutbound (missing params, bad E.164, identity mismatch, authorized happy path with `callerId`), handleStatus (dedupe, terminal `endedAt`, price/duration/status update + WS emit), handleFallback (TwiML shape).
  - `voice/voice.service.test.ts` — `issueToken` returns a real JWT, ownership assertion, NotFound; `prepareOutbound` rejects no-voice / inactive / non-E.164 / non-owner and returns identity + selected caller ID for the happy path; `getDeviceConfig` returns codec preferences and `closeProtection`.
  - `calls/calls.service.test.ts` — ownership guard, paginated `list` with `nextCursor`, invalid cursor rejected, `hangup` NotFound + non-active rejection + happy path (Twilio call update + DB update + audit + WS emit) + cursor codec round trip.

## Security and compliance

- All four `/webhooks/twilio/voice/*` endpoints **require** a valid Twilio signature; the `TwilioSignatureGuard` returns false otherwise → 403 with no DB write.
- Webhook bodies are dedup'd via `webhook_events.dedupeKey` (unique). Keys: `voice:inbound:{CallSid}`, `voice:outbound:{CallSid}`, `voice:status:{CallSid}:{CallStatus}`.
- Outbound TwiML handler verifies the caller's `client:` identity matches `voiceIdentity(userId, numberId)` — a user cannot place an outbound call from a Twilio number they do not own, even if they tamper with `selectedNumberId`.
- `prepareOutbound` (REST) repeats the same ownership + voice-capability + E.164 checks before the browser dials.
- Caller ID is always the selected Twilio number's E.164 — there is no parameter that lets the browser choose a different caller ID.
- No forwarding, no recording-to-email, no hidden bridges. Inbound calls only ring the owner's registered Twilio Voice client identity. If no device is available, the call hangs up gracefully.
- Audit logs: `voice.token_issued`, `call.hangup`, `call.note_added`.
- Voice tokens are short-lived (1h), use `TWILIO_API_KEY_SID` / `TWILIO_API_KEY_SECRET` (not the master Auth Token), and the browser refreshes them via `tokenWillExpire`.

## Acceptance criteria (from `10-phase-plan.txt`)

- [x] Browser rings on inbound PSTN call.
- [x] User can answer manually in the dedicated page.
- [x] User can reject call.
- [x] User can dial a PSTN destination from selected number.
- [x] Call logs update in real time.
- [x] Twilio status callbacks update database.
- [x] Invalid webhook signatures rejected.
- [x] Calls cannot be made from numbers not owned by the user.

## What's next (Phase 9)

- Polish the global frontend layout: sidebar, number switcher, connection-status indicators (API / WebSocket / Twilio Device), toasts, error boundary, dashboard cards.
- Wire all the existing pages into a coherent navigation flow with TanStack Query invalidation on every mutation, mobile-width responsive layout, and a typed API client surface used everywhere.

Phase 8 status: complete.
