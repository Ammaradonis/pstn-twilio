# Phase 8 — Post-Implementation Checklist

## What ships in this phase

### Backend

- [x] `VoiceModule` — JWT-protected REST endpoints for voice tokens, identity, device config, and outbound prep.
  - `POST /api/voice/token` — mints a short-lived Twilio Access Token with a `VoiceGrant` (incoming allowed, `outgoingApplicationSid` = TwiML App SID), throttled 20/min. Audited as `voice.token_issued`.
  - `GET /api/voice/identity` — returns the deterministic identity (`user_{userId}` or `user_{userId}_number_{numberId}`).
  - `GET /api/voice/device-config` — codec preferences, edges, log level, close protection.
  - `POST /api/calls/prepare-outbound` — validates ownership, voice capability, active flag, and E.164 destination before letting the browser dial.
- [x] `CallsModule` — JWT-protected call log + control surface.
  - `GET /api/numbers/:numberId/calls?cursor&limit&direction&status&since` — cursor-paginated by `(createdAt DESC, id DESC)`.
  - `GET /api/numbers/:numberId/calls/:callId`
  - `POST /api/calls/:callId/hangup` — only for `INITIATED | RINGING | IN_PROGRESS`; updates Twilio + DB; emits `call.status.updated`; audited.
  - `POST /api/calls/:callId/notes` — audited as `call.note_added`.
- [x] `WebhooksModule` — Twilio voice webhooks, all guarded by `TwilioSignatureGuard`.
  - `POST /webhooks/twilio/voice/inbound` — validates signature, looks up number by `To`, persists call, emits `call.inbound.ringing`, returns `<Dial answerOnBridge timeout="30"><Client statusCallback statusCallbackEvent>{identity}</Client></Dial>`.
  - `POST /webhooks/twilio/voice/outbound` — validates signature, parses `client:` identity from `From`, verifies the caller identity matches `voiceIdentity(userId, numberId)`, returns `<Dial callerId="{E.164}" answerOnBridge><Number>{destination}</Number></Dial>`.
  - `POST /webhooks/twilio/voice/status` — dedupes by `voice:status:{CallSid}:{CallStatus}`, persists status / duration / price / parentCallSid / answeredAt / endedAt, emits `call.status.updated`.
  - `POST /webhooks/twilio/voice/fallback` — graceful `<Say><Hangup/>`. The inbound/outbound handlers also fall back to this TwiML if anything throws, so Twilio never sees a 500.
- [x] `voice-status.mapper.ts` — Twilio raw status → `CallStatus` enum (case-insensitive, safe default).
- [x] `RealtimeService` already exposes `callInboundRinging` + `callStatusUpdated` from Phase 7; Phase 8 wires them up.

### Frontend

- [x] `apps/web/src/hooks/use-voice-device.tsx` — production hook around `@twilio/voice-sdk`:
  - Browser support check (RTCPeerConnection + getUserMedia).
  - Microphone permission detection via `navigator.permissions.query({ name: 'microphone' })`.
  - Token mint + `Device.register()`.
  - `tokenWillExpire` listener + scheduled token refresh (60s before expiry).
  - Connection state machine: `idle → pending → ringing → open → closed`.
  - Mute / unmute, hangup, accept / reject with cleanup on `cancel` and `disconnect`.
  - All errors surfaced via `error` state.
- [x] `apps/web/src/pages/answer.tsx` — full incoming-call UI:
  - Device readiness pills (WebRTC, registered, ready, mic permission).
  - Microphone-blocked + browser-unsupported warnings.
  - Incoming call card with Answer / Reject.
  - Live call card with mute and hangup.
- [x] `apps/web/src/pages/dial.tsx` — full outbound dialer UI:
  - E.164 input with on-the-fly validation.
  - 12-key dial pad.
  - Caller ID display (locked to selected number).
  - Live status, mute, hangup, clear.
- [x] `apps/web/src/pages/calls.tsx` — call log table fed by TanStack Query, kept live by `useRealtimeCalls`.
- [x] `apps/web/src/hooks/use-realtime-calls.ts` — handles `call.inbound.ringing` and `call.status.updated`, upserting into the cache (no duplicates).

## API surface delivered in Phase 8

| Method | Path                                   | Auth                  | Notes                                                            |
| ------ | -------------------------------------- | --------------------- | ---------------------------------------------------------------- |
| POST   | `/api/voice/token`                     | JWT                   | Throttled 20/min. Issues a 1h Twilio Access Token + VoiceGrant.  |
| GET    | `/api/voice/identity`                  | JWT                   | Returns scoped voice identity.                                   |
| GET    | `/api/voice/device-config`             | JWT                   | Twilio Device init options.                                      |
| POST   | `/api/calls/prepare-outbound`          | JWT                   | Validates ownership + voice capability + E.164 destination.      |
| GET    | `/api/numbers/:numberId/calls`         | JWT                   | Cursor pagination.                                               |
| GET    | `/api/numbers/:numberId/calls/:callId` | JWT                   | Ownership-checked.                                               |
| POST   | `/api/calls/:callId/hangup`            | JWT                   | Only for active calls. Updates Twilio + DB. Audited.             |
| POST   | `/api/calls/:callId/notes`             | JWT                   | Audited as `call.note_added`.                                    |
| POST   | `/webhooks/twilio/voice/inbound`       | Twilio signature only | Returns `<Dial><Client/></Dial>` TwiML.                          |
| POST   | `/webhooks/twilio/voice/outbound`      | Twilio signature only | Returns `<Dial callerId><Number/></Dial>` TwiML.                 |
| POST   | `/webhooks/twilio/voice/status`        | Twilio signature only | Dedup'd. Updates call state + emits realtime event. Returns 204. |
| POST   | `/webhooks/twilio/voice/fallback`      | Twilio signature only | Graceful `<Say><Hangup/>`.                                       |

## WebSocket events emitted

- `call.inbound.ringing` — payload: `{ numberId, call: CallDto }`.
- `call.status.updated` — payload: `{ numberId, call: CallDto }`.

The frontend cache update handler upserts (existing rows are replaced, new rows are prepended) so duplicate webhook delivery cannot duplicate the UI table.

## Compliance + safety

- Webhook signature is **required** on all four `/webhooks/twilio/voice/*` endpoints — `TwilioSignatureGuard` returns false on missing/invalid signature.
- Webhook bodies are dedup'd via `webhook_events.dedupeKey` (unique index): `voice:inbound:{CallSid}`, `voice:outbound:{CallSid}`, `voice:status:{CallSid}:{CallStatus}`.
- The outbound TwiML handler verifies the caller's `client:` identity matches `voiceIdentity(userId, numberId)`. A user cannot place a call from a number they do not own, even if they craft a `selectedNumberId`.
- `prepareOutbound` (the API path the dialer page hits before connecting the SDK) repeats ownership + voice-capability + E.164 validation, so the browser cannot bypass it either.
- No call forwarding to outside numbers, no auto-record-to-email, no hidden bridges — inbound calls only go to the owner's registered Twilio Voice client identity.
- All sensitive mutations are audited: `voice.token_issued`, `call.hangup`, `call.note_added`.
- Caller ID on outbound calls is always set to the **selected Twilio number's E.164** — there is no parameter that lets the browser choose a different caller ID.

## Tests

- `voice-status.mapper.test.ts` — every Twilio voice status string + unknown sentinel + case-insensitivity.
- `voice.service.test.ts` (webhook service) — handleInbound (missing fields, unknown number, happy path with `<Dial><Client/></Dial>`), handleOutbound (missing fields, invalid E.164, identity mismatch, happy path with `<Dial callerId><Number/></Dial>`), handleStatus (dedupe, terminal-state `endedAt`, price + duration update, status broadcast), handleFallback (TwiML shape).
- `voice/voice.service.test.ts` (token service) — token issuance includes a real JWT, ownership assertion, NotFound for missing numbers, prepareOutbound validation matrix (no-voice, inactive, non-E.164, non-owner) + happy path returning identity + selected caller ID.
- `calls/calls.service.test.ts` — list ownership guard, pagination cursor, invalid cursor rejected, hangup guards (NotFound, COMPLETED rejected) and happy path (Twilio call + DB update + audit log + WS emit).

## Verification commands

```pwsh
pnpm install
pnpm --filter @pstn-twilio/api prisma:generate
pnpm --filter @pstn-twilio/api typecheck
pnpm --filter @pstn-twilio/web typecheck
pnpm --filter @pstn-twilio/api test
pnpm --filter @pstn-twilio/api dev    # in one terminal
pnpm --filter @pstn-twilio/web dev    # in another
```

## Manual smoke test (requires real Twilio number + public webhook URL)

1. Provision a voice-capable number via the Phase 6 UI.
2. Open `/numbers/:numberId/answer` in a desktop browser. Allow microphone access.
3. Confirm the readiness pills go to `WebRTC supported`, `Registered`, `Ready`, `Mic: granted`.
4. From an external phone, call the Twilio number. The browser should ring within a few seconds and an "Incoming call" card should appear.
5. Click **Answer**. Verify two-way audio.
6. Click **Mute** — confirm the other side stops hearing you. **Unmute**.
7. Click **Hangup** — confirm the call ends and `/numbers/:numberId/calls` shows the row with `COMPLETED` and a duration in real time.
8. Open `/numbers/:numberId/dial`. Enter an E.164 destination, click **Call**. Verify the destination phone rings and the displayed status transitions `pending → ringing → open`.
9. Tamper with the `X-Twilio-Signature` header on a replayed webhook — the request must return 403 and no DB row should be written.
10. Replay the same `voice/status` webhook twice — the call row must not be updated twice (`webhook_events.dedupe_key` unique).

## Acceptance criteria (from `10-phase-plan.txt`)

- [x] Browser rings on inbound PSTN call (Twilio Device `incoming` event → Answer page card).
- [x] User can answer manually in the dedicated page.
- [x] User can reject call.
- [x] User can dial a PSTN destination from selected number.
- [x] Call logs update in real time (Socket.IO `call.inbound.ringing` + `call.status.updated` → TanStack Query cache).
- [x] Twilio status callbacks update the database (`/webhooks/twilio/voice/status`).
- [x] Invalid webhook signatures rejected (`TwilioSignatureGuard` returns false → 403, no DB write).
- [x] Calls cannot be made from numbers not owned by the user (server-side ownership check on the REST `prepareOutbound` path **and** on the TwiML `outbound` handler — defense in depth).
