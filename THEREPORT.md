opencode run [read "C:\Users\FingerWeg\CascadeProjects\pstn-twilio\THEREPORT.md" and upgrade the outbound calling infrastructure using your ADVANCED Twilio skills]

analyze the softphone's technical infrastructure then document everything about the 'dial' feature for outbound
calling within the softphone in an MD file called 'THEREPORT'. THEREPORT must be 10,000+ words. keep it clean with
headlines and sections. highlight limits, weaknesses, problems, strengths, insecurities, solutions, needs, enhancements,
bottlenecks, suggestions for outbound calling that relies mostly on Twilio within the softphone

# THEREPORT: Softphone Dial Feature — Outbound Calling Technical Analysis

**Project:** pstn-twilio  
**Date:** 2026-09-24  
**Scope:** Full technical analysis of the `dial` feature for outbound PSTN calling within the browser softphone, including infrastructure, security, bottlenecks, weaknesses, strengths, and enhancement recommendations.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Overview and Stack](#2-system-overview-and-stack)
3. [Outbound Call Architecture](#3-outbound-call-architecture)
4. [The Outbound Call Intent Pattern](#4-the-outbound-call-intent-pattern)
5. [Backend: Voice Service](#5-backend-voice-service)
6. [Backend: Webhook Service — Outbound Handler](#6-backend-webhook-service--outbound-handler)
7. [Backend: Calls Service](#7-backend-calls-service)
8. [Backend: Twilio Service](#8-backend-twilio-service)
9. [Frontend: The Dial Page](#9-frontend-the-dial-page)
10. [Frontend: The useVoiceDevice Hook](#10-frontend-the-usevoicedevice-hook)
11. [Data Models](#11-data-models)
12. [Shared Types and Schema Validation](#12-shared-types-and-schema-validation)
13. [Security Analysis](#13-security-analysis)
14. [Call Recording](#14-call-recording)
15. [Realtime Feedback](#15-realtime-feedback)
16. [Strengths](#16-strengths)
17. [Weaknesses and Problems](#17-weaknesses-and-problems)
18. [Limits and Constraints](#18-limits-and-constraints)
19. [Bottlenecks](#19-bottlenecks)
20. [Security Vulnerabilities and Insecurities](#20-security-vulnerabilities-and-insecurities)
21. [Needs and Missing Features](#21-needs-and-missing-features)
22. [Enhancement Suggestions](#22-enhancement-suggestions)
23. [Conclusion](#23-conclusion)

---

## 1. Executive Summary

The `pstn-twilio` softphone is a single-owner web application that provisions Twilio phone numbers and allows the owner to place outbound PSTN calls directly from a browser. The dial feature is the most technically complex part of the system — it spans a React frontend, a NestJS backend, Twilio's Voice JavaScript SDK, and Twilio's cloud telephony infrastructure. This report documents every layer of that pipeline in detail, then examines its strengths, weaknesses, security posture, bottlenecks, and opportunities for improvement.

At a high level, the outbound call flow works as follows:

1. The browser loads the dial page, which initializes a Twilio Voice `Device` using a short-lived access token issued by the backend.
2. When the user presses Call, the backend atomically creates an `OutboundCallIntent` record (valid for 2 minutes) that locks the destination, caller ID, and recording preference.
3. The Twilio SDK calls `Device.connect()`, which triggers the TwiML App's Voice URL on the backend.
4. The backend consumes the intent, verifies every parameter, and returns TwiML `<Dial><Number>` to Twilio with the locked caller ID.
5. Twilio bridges the call, fires status callbacks, and optionally starts a dual-channel recording.
6. The frontend polls and downloads the recording automatically when it is ready.

This design is architecturally sound and significantly more secure than naive approaches. It also has real weaknesses: total Twilio vendor lock-in, a 2-minute intent expiry that can cause races on slow networks, no call transfer or hold, limited observability, and several frontend edge cases in the device lifecycle manager.

---

## 2. System Overview and Stack

### 2.1 Repository Layout

The project is a pnpm monorepo with three workspaces:

```
apps/api/      NestJS 10 backend — all business logic, Twilio SDK, Prisma, webhooks
apps/web/      Vite + React 18 frontend — the browser softphone UI
packages/shared/ Pure TypeScript — DTOs, Zod schemas, enums shared by both apps
```

### 2.2 Technology Stack

**Backend (`apps/api`)**

- NestJS 10 on Node.js 22
- TypeScript 5.9
- Prisma 6 ORM targeting PostgreSQL (Neon serverless)
- ioredis 5 targeting Upstash Redis
- twilio Node SDK 5.13
- pino / nestjs-pino structured logging
- @nestjs/throttler for rate limiting
- argon2id for password hashing
- Passport JWT for authentication
- Socket.IO 4 for real-time events

**Frontend (`apps/web`)**

- Vite 6 + React 18 + TypeScript 5.9
- @twilio/voice-sdk 2.18.4 (patched)
- TanStack Query 5 for server state
- Zustand 5 for auth store
- socket.io-client 4 for real-time events
- React Router 7
- Tailwind CSS 3

**Shared (`packages/shared`)**

- Zod 3 for runtime schema validation
- DTOs and TypeScript interfaces only — no runtime dependencies

**Infrastructure**

- Frontend: Cloudflare Pages (static)
- Backend: Fly.io or Render (Node-friendly host)
- Database: Neon (PostgreSQL serverless)
- Cache/queue: Upstash (Redis serverless)
- DNS: Cloudflare
- Domain: webfitalchemist.online

### 2.3 Key Twilio Components Used

| Component                           | Purpose                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------- |
| Twilio Account SID + Auth Token     | Webhook signature validation, REST API calls                                |
| Twilio API Key SID + API Key Secret | Minting Voice Access Tokens for the browser                                 |
| TwiML App SID                       | Registered Voice URL target that Twilio calls when `Device.connect()` fires |
| Twilio Voice JavaScript SDK 2.18.4  | Browser-side WebRTC/SIP stack                                               |
| Twilio Voice Access Token           | Short-lived JWT that authorizes one browser identity to place/receive calls |
| Twilio `<Dial><Number>` TwiML       | Server-side instruction to connect the browser leg to a PSTN number         |
| Twilio Recording API                | Dual-channel MP3 recording attached to the call                             |
| Twilio Status Callbacks             | Webhook fired on every call state transition                                |

---

## 3. Outbound Call Architecture

### 3.1 Full Flow Diagram

```
Browser (Dial Page)
  │
  │ 1. GET /api/voice/token
  │    → VoiceService.issueToken()
  │    → Returns: { token, identity, expiresAt }
  │
  │ 2. new Device(token, config)
  │    → Device registers with Twilio signaling (WebSocket)
  │
  │ 3. POST /api/calls/prepare-outbound
  │    → VoiceService.prepareOutbound()
  │    → Validates: number ownership, voice capability, active status,
  │                 Twilio live caller ID check, E.164 destination
  │    → Creates: OutboundCallIntent (TTL 2 min)
  │    → Returns: OutboundCallPreparationDto
  │
  │ 4. Device.connect({ params: { selectedNumberId, destinationNumber, outboundIntentId } })
  │
  ├── Twilio Voice Cloud ──────────────────────────────────────────────────
  │     │
  │     │ 5. POST /webhooks/twilio/voice/outbound (TwiML App Voice URL)
  │     │    → TwilioSignatureGuard validates X-Twilio-Signature
  │     │    → VoiceWebhookService.handleOutbound()
  │     │       - Validates: identity, selectedNumberId, destinationNumber, outboundIntentId
  │     │       - consumeOutboundIntent(): atomic updateMany where consumedAt IS NULL
  │     │       - Checks: intent not expired, caller identity matches, number active
  │     │       - Returns: TwiML <Dial callerId="+1..." answerOnBridge> <Number> + recording attrs
  │     │
  │     │ 6. Twilio dials the PSTN destination
  │     │
  │     │ 7. Status callbacks → POST /webhooks/twilio/voice/status
  │     │    → VoiceWebhookService.handleStatus()
  │     │    → Updates Call row, emits call.status.updated via Socket.IO
  │     │
  │     │ 8. (if recordCall=true) Recording callbacks → POST /webhooks/twilio/voice/recording
  │     │    → VoiceWebhookService.handleRecording()
  │     │    → Upserts CallRecording row
  │     └──────────────────────────────────────────────────────────────────
  │
  │ 9. Frontend watchRecordingDownload() polls GET /api/numbers/:id/calls/by-intent/:intentId
  │    until recording status = COMPLETED, then auto-downloads MP3
```

### 3.2 Why This Architecture

The design was driven by several constraints:

- **Security**: Twilio credentials must never reach the browser. The browser only sees a Voice Access Token (scoped to one identity) and a `selectedNumberId`. It cannot forge a different caller ID or bypass ownership checks.
- **Replay prevention**: A naive `Device.connect({ To: '+1...' })` approach would let any code with the token call any number. The intent pattern adds a server-side authorization gate that is consumed exactly once.
- **Audit trail**: Every step — token issuance, intent creation, outbound webhook — produces an audit log entry.

---

## 4. The Outbound Call Intent Pattern

### 4.1 What It Is

`OutboundCallIntent` is a database record created by `POST /api/calls/prepare-outbound` and consumed atomically when Twilio fires the TwiML App Voice URL. It is the authorization token for one specific call.

**Schema:**

```prisma
model OutboundCallIntent {
  id                String    @id @default(uuid())
  userId            String
  phoneNumberId     String
  identity          String         // e.g. "user_abc123_number_def456"
  destinationE164   String         // locked E.164 destination
  selectedCallerId  String         // locked caller ID (E.164)
  expiresAt         DateTime       // now + 2 minutes
  consumedAt        DateTime?      // set when Twilio fires the webhook
  consumedByCallSid String?        // Twilio CallSid that consumed it
  recordCall        Boolean  @default(true)
}
```

### 4.2 Creation

In `VoiceService.prepareOutbound()`, the intent is created after a sequence of checks:

1. **Ownership check**: The `selectedNumberId` must belong to the authenticated user.
2. **Capability check**: The number must have `capabilitiesVoice = true`.
3. **Active check**: The number must have `active = true`.
4. **Live Twilio check**: The service calls `twilio.api.v2010.accounts(...).incomingPhoneNumbers(...).fetch()` and verifies:
   - The number still exists in Twilio (404 → deactivate it locally).
   - The number still matches the E.164 stored in the DB.
   - The number still has voice capability in Twilio.
5. **E.164 normalization**: The destination is run through `normalizeDialablePhoneNumber()` which accepts partial US numbers and normalizes to E.164.
6. **VoiceIdentity upsert**: A `VoiceIdentity` row is created/updated so that the identity string is traceable back to a user and number.

### 4.3 Consumption

In `VoiceWebhookService.handleOutbound()`, the intent is consumed with an atomic update:

```typescript
const consumed = await this.prisma.outboundCallIntent.updateMany({
  where: {
    id: intent.id,
    consumedAt: null, // not yet consumed
    expiresAt: { gt: now }, // not yet expired
  },
  data: {
    consumedAt: now,
    consumedByCallSid: input.callSid,
  },
});
if (consumed.count !== 1) {
  // Lost the race — reject
  return hangupTwiml('Call authorization expired.');
}
```

This pattern prevents:

- **Replay attacks**: A consumed intent cannot be used again.
- **Race conditions**: Two concurrent webhook invocations with the same intent ID cannot both succeed.
- **Staleness**: An expired intent is rejected.

There is also a `sameCallRetry` path for Twilio's own webhook retry mechanism (same `CallSid` retrying), which skips the consumption check to avoid breaking legitimate retries.

### 4.4 Validation at Consumption Time

Before consumption, the webhook service validates six things:

1. `intent.identity === input.identity` (the browser identity matches what was authorized)
2. `expectedIdentity === input.identity` (the identity matches what the server would derive for this user+number combo)
3. `intent.phoneNumberId === input.selectedNumberId` (the number ID matches)
4. `intent.destinationE164 === input.destinationNumber` (the destination matches)
5. `intent.selectedCallerId === phoneNumber.phoneNumberE164` (the caller ID still matches the DB)
6. `phoneNumber.active && phoneNumber.capabilitiesVoice && phoneNumber.userId` (number is still valid)

Any mismatch produces a warning log and a TwiML `<Hangup>`.

### 4.5 TTL: The 2-Minute Window

The intent expires 2 minutes after creation (`OUTBOUND_INTENT_TTL_MS = 2 * 60 * 1000`). This window covers:

- The time for `Device.connect()` to negotiate with Twilio's signaling layer.
- The time for Twilio to call the TwiML App URL.
- Any Twilio retries.

**Weakness**: On very slow networks or under high Twilio API latency, 2 minutes may not be enough. The frontend has no mechanism to re-prepare the intent mid-flight — if it expires before Twilio fires the webhook, the call silently fails with a hangup. There is no user-visible error in this scenario.

---

## 5. Backend: Voice Service

**File:** `apps/api/src/voice/voice.service.ts`

### 5.1 Token Issuance

`VoiceService.issueToken()` creates a Twilio Voice Access Token using `twilio.jwt.AccessToken`:

```typescript
const accessToken = new twilio.jwt.AccessToken(accountSid, apiKeySid, apiKeySecret, {
  identity,
  ttl: 3600, // 1 hour
  nbf: issuedNow - 300, // 5-minute clock skew tolerance
});
accessToken.addGrant(
  new twilio.jwt.AccessToken.VoiceGrant({
    incomingAllow: true,
    outgoingApplicationSid: twimlAppSid,
  }),
);
```

Key properties:

- **TTL**: 1 hour. The frontend schedules a proactive refresh 60 seconds before expiry.
- **Clock skew**: `nbf` is backdated 5 minutes to tolerate server clock drift.
- **Scope**: The token is bound to a specific TwiML App SID, so it can only originate calls through that app.
- **Identity**: Scoped to `user_<userId>_number_<numberId>` — even if leaked, it can only place calls as that identity on that number.

The token's expiry time is decoded from the JWT's `exp` claim and returned to the frontend as `expiresAt`, which drives the proactive refresh timer.

### 5.2 Device Configuration

`getDeviceConfig()` returns:

```typescript
{
  codecPreferences: ['opus', 'pcmu'],  // Opus first for FEC + jitter tolerance
  edge: ['frankfurt', 'dublin', 'ashburn'],  // Multi-region fallback
  dscp: true,                           // Mark packets as high priority
  logLevel: 1,                          // Warnings only
  closeProtection: true,                // Prevents accidental page unload during call
  enableImprovedSignalingErrorPrecision: true,
  tokenRefreshMs: 60_000,
  maxCallSignalingTimeoutMs: 30_000,
}
```

The `edge` configuration is important: if Frankfurt is unavailable, the SDK will failover to Dublin then Ashburn. `dscp` marks RTP packets for QoS on networks that respect DSCP, which can improve audio quality. The codec ordering (`opus` before `pcmu`) is intentional — Opus has forward error correction that tolerates packet loss better than PCMU.

### 5.3 Live Twilio Caller ID Validation

`assertTwilioCallerIdUsable()` makes a live API call to Twilio before allowing the intent to be created. This is both a strength and a bottleneck:

**Strength**: It catches numbers that have been released or lost voice capability in Twilio but not yet synced to the local DB. It also auto-deactivates them locally.

**Weakness/Bottleneck**: Every outbound call preparation triggers an extra Twilio REST API call (fetching the `IncomingPhoneNumber` resource). Under normal conditions this adds ~100–300 ms. If Twilio's REST API is slow or rate-limited, it will delay every call setup. There is no caching of this result.

### 5.4 Rate Limiting on Voice Endpoints

The voice token endpoint has throttle decorators:

```typescript
@Throttle({ short: { limit: 20, ttl: 60_000 } })  // POST /api/voice/token
@Throttle({ short: { limit: 30, ttl: 60_000 } })  // POST /api/calls/prepare-outbound
```

This limits token issuance to 20/minute and outbound preparation to 30/minute per client. These limits are reasonable for a single-owner application but would need adjustment in multi-tenant scenarios.

---

## 6. Backend: Webhook Service — Outbound Handler

**File:** `apps/api/src/webhooks/voice.service.ts`

### 6.1 The handleOutbound() Method

This is the most critical path in the entire dial feature. Twilio calls this endpoint when `Device.connect()` fires. It must respond with TwiML within Twilio's timeout (typically 15 seconds).

The method:

1. Validates all required parameters exist (CallSid, identity, selectedNumberId, destinationNumber, outboundIntentId).
2. Normalizes the destination to E.164.
3. Consumes the `OutboundCallIntent` atomically.
4. Fires `persistOutboundStart()` in the background (void — not awaited) to avoid adding latency to the TwiML response.
5. Builds and returns TwiML.

### 6.2 TwiML Construction

When the intent is valid and `recordCall = true`, the TwiML looks like:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial callerId="+15551234567"
        answerOnBridge="true"
        record="record-from-answer-dual"
        recordingStatusCallback="https://api.host/webhooks/twilio/voice/recording"
        recordingStatusCallbackMethod="POST"
        recordingStatusCallbackEvent="in-progress completed absent"
        recordingTrack="both"
        trim="do-not-trim">
    <Number
      statusCallback="https://api.host/webhooks/twilio/voice/status"
      statusCallbackMethod="POST"
      statusCallbackEvent="initiated ringing answered completed">
      +15559876543
    </Number>
  </Dial>
</Response>
```

Key points:

- `callerId` is taken from the database (the phone number's `phoneNumberE164`), not from the browser's request. This means the caller ID cannot be spoofed at the webhook level.
- `answerOnBridge="true"` means the browser leg hears ringing until the remote side answers.
- `record="record-from-answer-dual"` records both channels from when the call is answered, not just one channel from the start.
- `trim="do-not-trim"` preserves silence at the beginning and end of the recording.

When `recordCall = false`, the `Dial` element has no recording attributes.

### 6.3 Background Persistence

`persistOutboundStart()` is called with `void` (fire and forget):

```typescript
void this.persistOutboundStart({ ... });
```

This is intentional — Twilio requires a fast TwiML response (within ~15 seconds, often much less in practice), and DB writes should not be on the critical path. However, this means:

- If the background write fails, the call will proceed but the `Call` row may not be created in time.
- Status callbacks may arrive before the `Call` row exists, causing the status handler to create the row itself (which it handles).

### 6.4 Status Handling

`handleStatus()` receives status callbacks from Twilio:

| Twilio Status | DB Status   |
| ------------- | ----------- |
| initiated     | INITIATED   |
| ringing       | RINGING     |
| in-progress   | IN_PROGRESS |
| completed     | COMPLETED   |
| busy          | BUSY        |
| failed        | FAILED      |
| no-answer     | NO_ANSWER   |
| canceled      | CANCELED    |

The service uses a rank-based update: it only moves to a new status if `CALL_STATUS_RANK[newStatus] >= CALL_STATUS_RANK[existingStatus]`. This prevents out-of-order webhook delivery from regressing a completed call back to in-progress.

Deduplication uses the `WebhookEvent` table with a `dedupeKey = "voice:status:{CallSid}:{CallStatus}"`. If the key already exists, the handler returns without processing.

### 6.5 Fallback Handling

A `/webhooks/twilio/voice/fallback` endpoint returns a graceful TwiML message ("We are unable to complete your call right now") if the primary webhook URL fails. This prevents Twilio from playing its own generic error to the caller.

---

## 7. Backend: Calls Service

**File:** `apps/api/src/calls/calls.service.ts`

### 7.1 findByOutboundIntent()

This method is the backend of the recording polling mechanism. The frontend calls it after a call ends to find out when the recording is ready:

```
GET /api/numbers/:numberId/calls/by-intent/:intentId
```

It:

1. Validates ownership of the number and intent.
2. Finds the `CallSid` stored in `intent.consumedByCallSid`.
3. Fetches the `Call` with its `recordings` relation.
4. Returns `null` if Twilio hasn't fired the outbound webhook yet (intent not yet consumed).

### 7.2 findLastDial()

Before placing a call, the frontend checks:

```
GET /api/numbers/:numberId/last-dial?destination=+15551234567
```

If the number was dialed before from this phone number, the service returns a `LastDialDto { callId, destinationNumber, lastDialedAt }`. The frontend shows a confirmation dialog ("You last called this number on [date]. Call again?"). This is a small but genuinely useful UX feature that prevents accidental repeat-dials.

### 7.3 hangup()

The `POST /api/calls/:callId/hangup` route calls `twilio.client.calls(sid).update({ status: 'completed' })` — the Twilio REST API's method for server-side call termination. This is used for emergency hangup from the server, separate from the SDK's `call.disconnect()` on the frontend.

Only calls in `INITIATED`, `RINGING`, or `IN_PROGRESS` status can be hung up via this endpoint. Completed, failed, or canceled calls return a 400.

### 7.4 Recording Media Proxy

`getRecordingMedia()` proxies the Twilio recording download through the backend:

```typescript
const media = await this.twilio.fetchRecordingMedia(recording.twilioRecordingSid);
// Returns Buffer + content-type
```

This is necessary because Twilio recording media requires HTTP Basic Auth using the Account SID and Auth Token — credentials that must never reach the browser. The proxy fetches the MP3 server-side and streams it to the client.

**Bottleneck**: For large recordings (e.g., a 30-minute call), this proxies the entire MP3 through the backend server's memory and network. On a small Fly.io instance, this could exhaust memory or bandwidth. There is no streaming — it uses `response.arrayBuffer()` which buffers the entire file.

---

## 8. Backend: Twilio Service

**File:** `apps/api/src/twilio/twilio.service.ts`

### 8.1 Lazy Client Initialization

The Twilio client is initialized lazily:

```typescript
get client(): Twilio {
  if (!this.clientInstance) {
    this.clientInstance = twilio(this.accountSid, this.authToken);
  }
  return this.clientInstance;
}
```

**Problem**: If `TWILIO_ACCOUNT_SID` or `TWILIO_AUTH_TOKEN` are missing from the environment, this throws at the time the client is first accessed — not at startup. This delays the detection of misconfiguration until a call is attempted.

### 8.2 Voice Identity String

```typescript
voiceIdentity(userId: string, numberId?: string | null): string {
  const userPart = userId.replace(/[^a-zA-Z0-9]/g, '');
  if (numberId) {
    const numPart = numberId.replace(/[^a-zA-Z0-9]/g, '');
    return `user_${userPart}_number_${numPart}`;
  }
  return `user_${userPart}`;
}
```

UUIDs contain hyphens which are stripped here, so `"user_abc123def456_number_ghi789jkl012"`. These strings are used as Twilio client identity parameters and must be unique per user-number combination.

**Weakness**: Since UUIDs are stripped of hyphens, two different UUIDs that share the same alphanumeric characters would produce the same identity string. In practice this cannot happen with UUIDs (each UUID is unique by design), but the code doesn't make this invariant explicit.

### 8.3 Signature Validation

```typescript
validateSignature(signature: string | undefined, url: string, params: Record<string, unknown>) {
  if (!signature) return false;
  try {
    return validateRequest(this.authToken, signature, url, params);
  } catch {
    return false;
  }
}
```

The `validateRequest` function from the Twilio SDK validates the HMAC-SHA1 signature Twilio attaches to every webhook. The signature covers the full webhook URL (including query string) and all POST body parameters. If `TWILIO_WEBHOOK_BASE_URL` doesn't exactly match what Twilio is calling (e.g., `http` vs `https`, trailing slash), all webhooks will fail validation.

---

## 9. Frontend: The Dial Page

**File:** `apps/web/src/pages/dial.tsx`

### 9.1 Component Overview

The `DialPage` component is a full-featured softphone UI rendered at `/numbers/:numberId/dial`. It integrates with `useVoiceDevice()` and manages all outbound call state locally.

State variables:

- `destination` — the number typed or input by the user
- `callerId` — fetched from the API; the phone number's E.164 (displayed but locked)
- `submitting` — call preparation in progress
- `pageError` — error message to display
- `sentTones` — last 24 DTMF tones sent (displayed during call)
- `repeatDialWarning` — last dial DTO if the number was recently called
- `recordCall` — recording preference (default: `true`, persisted to localStorage)
- `activeCallRecorded` — whether the current call is being recorded

### 9.2 Call Initiation Sequence

When the user clicks **Call**, `placeCall()` runs:

```
1. Validate destination (E.164 normalization)
2. Check microphone permission
   - If denied: show error message
   - If unknown/prompt: request permission via requestMicPermission()
3. Check for recent dial (findLastDial)
   - If found: show confirmation dialog
4. voice.makeCall(numberId, destination, { recordCall, onPrepared })
   - Inside makeCall:
     a. initVoiceDevice() — ensure Device is ready
     b. api.voice.prepareOutbound() → OutboundCallPreparationDto
     c. ensureDeviceForOutbound() — verify identity matches
     d. Device.connect({ params: { selectedNumberId, destinationNumber, outboundIntentId } })
5. watchRecordingDownload() — start polling for recording
```

### 9.3 DTMF In-Call

While a call is active, the dialpad doubles as a DTMF sender. Key presses call `voice.sendDigits(key)` which maps to `call.sendDigits()` on the SDK. The last 24 tones are displayed below the pad. Keyboard input is also wired up — physical digit/`*`/`#` keys fire during a call.

### 9.4 Paste and Call

A dedicated **Paste** button reads the clipboard via `navigator.clipboard.readText()`, normalizes the text as a phone number, and immediately places the call. This is a convenience feature for users who copy phone numbers from other applications.

**Weakness**: `navigator.clipboard.readText()` requires a user gesture and HTTPS. In non-HTTPS environments or browsers without clipboard API support, this silently fails with an error message.

### 9.5 Record Call Toggle

A toggle switch controls whether the call is recorded. The preference is persisted to `localStorage` under the key `pstn-twilio.record-calls`. The default is `true` (recordings on) because prior to the setting being added, calls were always recorded.

The toggle is disabled during an active call — changing it only affects the next call. If the call is being recorded, a pulsing red "Recording" badge appears next to the "Record call" label.

### 9.6 Device Readiness Status Pills

The page shows four status pills:

- `WebRTC supported` / `WebRTC unavailable`
- `Registered` / `Reconnecting…` / `Not registered`
- `Ready` / `Initializing…`
- `Mic: granted/denied/unknown/prompt`

A **Enable Microphone** button appears if mic permission is not granted, which calls `voice.requestMicPermission()`. This is an important UX pattern — many users won't know why the call button is disabled without this indicator.

### 9.7 CallQualityPanel

During a call, `CallQualityPanel` displays real-time metrics from the SDK's WebRTC samples (emitted once per second):

- RTT (ms)
- Jitter (ms)
- Packet loss (%)
- MOS score
- Codec name

These are surfaced via the `call.on('sample', ...)` event listener attached in `attachCallListeners()`.

---

## 10. Frontend: The useVoiceDevice Hook

**File:** `apps/web/src/hooks/use-voice-device.tsx`

This is the most complex and critical file in the frontend. It manages the entire Twilio Voice SDK lifecycle as a module-level singleton — meaning one `Device` instance is shared across all React component instances and persists across route changes.

### 10.1 Architecture: Module-Level Singleton

The hook uses a module-level `runtime` object (not React state) to hold the device, call, timers, and connection state. React components subscribe to changes via a pub/sub system:

```typescript
const subscribers = new Set<() => void>();
const runtime = { state, device, call, lastNumberId, ... };

function emit() {
  for (const subscriber of subscribers) subscriber();
}

export function useVoiceDevice(): UseVoiceDevice {
  const [snapshot, setSnapshot] = useState(runtime.state);
  useEffect(() => subscribe(() => setSnapshot(runtime.state)), []);
  ...
}
```

**Strength**: This means the Device stays registered even when the user navigates between pages. Token refresh, reconnection backoff, and signaling recovery all continue in the background.

**Weakness**: Because state is module-level, there is no React lifecycle to clean it up on unmount. If the page is reloaded or the app is unmounted and remounted (e.g., in tests), stale timers or event listeners can leak. The `disposeCurrentDevice()` function is the only cleanup path, and it is not called automatically.

### 10.2 Device Initialization

`initVoiceDevice()` is an async function that:

1. Checks browser support (WebRTC + `getUserMedia`).
2. Skips re-initialization if the same `numberId` Device is already registered.
3. Fetches a voice token, imports the Twilio SDK (dynamic import for bundle splitting), and fetches device config — all in parallel.
4. Constructs `new Device(token, config)`.
5. Sets audio constraints (echo cancellation, noise suppression, auto-gain).
6. Attaches device-level event listeners.
7. Calls `registerCurrentDevice()`.

The dynamic import (`import('@twilio/voice-sdk')`) is significant — it splits the 180 KB SDK out of the main bundle. This is good for initial page load performance.

### 10.3 Reconnection Logic

The reconnect system handles:

- Token expiry/rejection (error codes 20101, 20104, 31202, 31204, 31205)
- Signaling drops (31005, 31009, 53001)
- Device destroyed by SDK itself

Reconnect schedule uses exponential backoff:

```typescript
const delay = Math.min(15_000, 1_000 * 2 ** Math.min(reconnectAttempt, 4));
// Attempts: 1s, 2s, 4s, 8s, 15s, 15s, 15s, 15s...
```

Max 8 attempts (`MAX_STALLED_REGISTRATION_RECONNECT_ATTEMPTS = 8`) reaching ~75 seconds before the hook creates a fresh Device.

**Design note**: The code comment explains why 8 retries were chosen — Twilio's SDK keeps a lost connection for up to 30 seconds before beginning edge fallback. Recreating the Device at the 30-second mark would reset the edge list and send the browser back to the failing edge.

### 10.4 Signaling Recovery

The SDK emits `reconnecting` and `reconnected` events for WebSocket drops it handles internally. The hook:

- On `reconnecting`: sets `signalingRecoveryPending = true`, schedules a reconnect.
- On `reconnected`: clears all reconnect state, marks registered.

There is also a `resume`/`online`/`visibilitychange` listener that fires when the user returns to the tab or reconnects to the network:

```typescript
function recoverNow() {
  if (runtime.device && !runtime.resumeTimer) {
    runtime.resumeTimer = setTimeout(replaceStalledDevice, RESUME_RECOVERY_GRACE_MS);
  }
  ...
}
```

The 4-second grace period (`RESUME_RECOVERY_GRACE_MS = 4_000`) lets the SDK restore signaling naturally before the app intervenes.

### 10.5 Android Earpiece Routing

```typescript
const ANDROID_EARPIECE_INPUT_LABEL = 'Headset earpiece';
const ANDROID_HEADSET_INPUT_LABELS = new Set(['Wired headset', 'Bluetooth headset', 'USB audio']);

async function callAudioConstraints(): Promise<MediaTrackConstraints> {
  const inputs = await navigator.mediaDevices.enumerateDevices();
  // If a headset is connected, use default constraints
  // If no headset and earpiece exists, route to earpiece
  ...
}
```

On Android Chrome, the virtual microphone devices include "Headset earpiece" which routes audio through the phone's top speaker. Without this, the phone's main speaker is used, causing echo. This code detects Android earpiece devices and requests them specifically (using `ideal` rather than `exact` so it falls back gracefully).

### 10.6 makeVoiceCall()

The core outbound call function:

1. Check mic permission.
2. Call `initVoiceDevice()`.
3. Call `api.voice.prepareOutbound()` — HTTP POST to backend.
4. Call `ensureDeviceForOutbound()` — verifies identity matches, recreates Device if needed.
5. Get audio constraints.
6. Call `device.connect({ params, audioConstraints, rtcConstraints })`.
7. Attach call event listeners.

**Important**: Steps 3 and 4 mean the Device must have the same identity as what the intent was prepared for. If the user navigated to a different number page between step 2 and step 3, the identities would differ, causing a logged error and early return.

### 10.7 unhandledrejection Listener

```typescript
window.addEventListener('unhandledrejection', (event) => {
  const code = getVoiceErrorCode(event.reason);
  if (!code || !RECONNECTABLE_ERROR_CODES.has(code) || !runtime.device) return;
  event.preventDefault();
  runtime.signalingRecoveryPending = true;
  scheduleReconnect(runtime.lastNumberId);
});
```

There is a note in the code: `voice-sdk 2.18.4 can reject an internal re-register after a signaling drop (fixed upstream in 2.18.5, not yet on npm)`. The patch file at `patches/@twilio__voice-sdk@2.18.4.patch` appears to be related to this. This is a known bug in the current SDK version that is being worked around.

---

## 11. Data Models

### 11.1 PhoneNumber

The source of truth for provisioned numbers. Key fields for the dial feature:

| Field                          | Type            | Purpose                                              |
| ------------------------------ | --------------- | ---------------------------------------------------- |
| `phoneNumberE164`              | String (unique) | The actual phone number; used as `callerId` in TwiML |
| `twilioIncomingPhoneNumberSid` | String (unique) | Twilio's internal SID; used for live validation      |
| `capabilitiesVoice`            | Boolean         | Must be `true` for outbound calls                    |
| `active`                       | Boolean         | Must be `true` for outbound calls                    |
| `userId`                       | String?         | Owner; checked during intent creation                |

### 11.2 OutboundCallIntent

Fully described in Section 4. Additional index notes:

```prisma
@@index([identity, expiresAt])       // Quick lookup by identity during webhook
@@index([phoneNumberId, createdAt])  // Pagination
@@index([expiresAt])                 // Cleanup of expired intents
@@index([consumedByCallSid])         // findByOutboundIntent polling
```

The `[expiresAt]` index suggests that expired intents should be periodically cleaned up — but there is no cleanup job implemented. Over time, the table will accumulate expired, unconsumed intents (e.g., when a user prepares a call but doesn't actually place it).

### 11.3 Call

| Field                          | Type             | Purpose                                         |
| ------------------------------ | ---------------- | ----------------------------------------------- |
| `twilioCallSid`                | String? (unique) | Twilio's CallSid                                |
| `parentCallSid`                | String?          | For child legs in complex call flows            |
| `direction`                    | Enum             | INBOUND / OUTBOUND                              |
| `fromE164` / `toE164`          | String           | Raw from/to as reported by Twilio               |
| `browserIdentity`              | String?          | The Twilio client identity that placed the call |
| `selectedCallerId`             | String?          | The locked caller ID (from the intent)          |
| `destinationE164`              | String?          | The locked destination (from the intent)        |
| `status`                       | Enum             | INITIATED through COMPLETED/FAILED/etc.         |
| `durationSeconds`              | Int?             | Set by the status callback                      |
| `price` / `priceUnit`          | String?          | Twilio billing data                             |
| `startedAt/answeredAt/endedAt` | DateTime?        | Lifecycle timestamps                            |

### 11.4 CallRecording

| Field                | Type            | Purpose                                                          |
| -------------------- | --------------- | ---------------------------------------------------------------- |
| `twilioRecordingSid` | String (unique) | Twilio's recording SID                                           |
| `recordingUrl`       | String?         | Twilio's API URL for the MP3                                     |
| `status`             | Enum            | IN_PROGRESS / COMPLETED / ABSENT                                 |
| `channels`           | Int?            | 2 for dual-channel, 1 for mono                                   |
| `source`             | String?         | `"RecordVerb"` for call recordings, `"voicemail"` for voicemails |
| `track`              | String?         | `"both"` for dual-channel                                        |

### 11.5 VoiceIdentity

Tracks which identity strings have been issued to which users/numbers. Used for auditing. Created/upserted on every token issuance.

### 11.6 WebhookEvent

Deduplication table. Every incoming webhook is recorded here with a `dedupeKey`. If the key exists, the handler skips processing. This prevents duplicate call records from Twilio's retry mechanism.

---

## 12. Shared Types and Schema Validation

### 12.1 prepareOutboundCallSchema

```typescript
z.object({
  selectedNumberId: z.string().uuid(),
  destinationNumber: dialablePhoneNumberSchema, // auto-normalizes to E.164
  callContextId: z.string().uuid().optional(), // unused for now
  recordCall: z.boolean().optional(),
});
```

The `dialablePhoneNumberSchema` uses `z.preprocess` to run `normalizeDialablePhoneNumber()` before the E.164 regex check. This means partial US numbers like `"530-441-9961"` are accepted and normalized to `"+15304419961"` at the schema level.

### 12.2 OutboundCallPreparationDto

```typescript
interface OutboundCallPreparationDto {
  outboundIntentId: string; // UUID of the created intent
  selectedNumberId: string; // UUID of the phone number
  selectedCallerId: string; // E.164 of the caller ID
  destinationNumber: string; // E.164 of the destination
  identity: string; // e.g. "user_abc123_number_def456"
  expiresAt: string; // ISO-8601 expiry timestamp
  recordCall: boolean; // Whether this call will be recorded
}
```

This DTO is the contract between the backend preparation step and the `Device.connect()` call. The `outboundIntentId` is passed as a TwiML parameter so the webhook can look up the intent.

### 12.3 Phone Number Normalization

`normalizeDialablePhoneNumber()` in `packages/shared/src/phone.ts` handles:

- E.164 numbers: returned as-is
- US 10-digit numbers (with or without dashes/spaces): prepended with `+1`
- US 11-digit numbers starting with `1`: prepended with `+`
- Numbers that cannot be normalized: returns `null`

This is used client-side (in the dial input) and server-side (in both services). Using the same library ensures consistent behavior.

---

## 13. Security Analysis

### 13.1 Credential Isolation

The architecture strictly separates what the browser can see from what the server holds:

| Secret                | Browser can see?                  |
| --------------------- | --------------------------------- |
| TWILIO_ACCOUNT_SID    | No                                |
| TWILIO_AUTH_TOKEN     | No                                |
| TWILIO_API_KEY_SID    | No                                |
| TWILIO_API_KEY_SECRET | No                                |
| TWILIO_TWIML_APP_SID  | No                                |
| Voice Access Token    | Yes (short-lived, scoped)         |
| selectedNumberId      | Yes (UUID, not sensitive)         |
| outboundIntentId      | Yes (UUID, single-use, 2-min TTL) |

### 13.2 Webhook Authentication

Every Twilio webhook is protected by `TwilioSignatureGuard`:

```typescript
validateRequest(authToken, signature, url, params);
```

This is an HMAC-SHA1 validation using the Auth Token. The guard runs before any business logic, so unsigned or mis-signed requests never reach the database. This is the correct approach and is thoroughly tested.

### 13.3 The Intent Pattern as Authorization Gate

The `OutboundCallIntent` is the most sophisticated security mechanism in the dial feature. Without it:

- Anyone with a valid Voice Access Token could call any number via `Device.connect({ params: { To: '+1...' } })`.
- The caller ID could be any number in Twilio's inventory.
- There would be no server-side audit of what number was dialed.

With the intent pattern:

- The caller ID is locked server-side before the call is placed.
- The destination is locked server-side.
- The browser identity is locked server-side.
- A consumed intent cannot be reused.
- An expired intent is rejected.

### 13.4 JWT Authentication on API Routes

All `/api/*` routes (except health and auth login) require a valid `Authorization: Bearer <jwt>` header. The JWT is validated by `JwtAuthGuard` using Passport JWT. The JWT secret is in the API environment only.

Voice tokens and outbound intents are always created under an authenticated session. There is no anonymous call path.

### 13.5 Audit Logging

Every security-relevant action is logged:

- `voice.token_issued` — with actor userId, numberId
- `voice.outbound_prepared` — with actor, numberId, destination, recordCall flag
- `call.hangup` — with actor, callId, twilioCallSid

These logs are append-only (no update/delete) and stored in PostgreSQL with actor IP and user agent.

### 13.6 DTMF Security

DTMF digits are validated before sending:

```typescript
const DTMF_DIGITS_PATTERN = /^[0-9*#w]+$/;
```

Only `0-9`, `*`, `#`, and `w` (pause) are allowed. This prevents injection of unexpected characters into the DTMF stream.

---

## 14. Call Recording

### 14.1 Recording Architecture

Recording is opt-in (controlled by the `recordCall` toggle) but defaults to `true`. When enabled, the `<Dial>` TwiML verb includes:

```
record="record-from-answer-dual"
recordingTrack="both"
trim="do-not-trim"
```

This records both channels (caller and callee) from the moment the call is answered. The `do-not-trim` setting preserves silence.

### 14.2 Recording Lifecycle

```
Call answered
  → Twilio starts recording
  → POST /webhooks/twilio/voice/recording (RecordingStatus=in-progress)
     → VoiceWebhookService.handleRecording() → upsert CallRecording (status=IN_PROGRESS)

Call ends
  → Twilio processes recording (typically 5–60 seconds)
  → POST /webhooks/twilio/voice/recording (RecordingStatus=completed)
     → upsert CallRecording (status=COMPLETED, recordingUrl=...)
     → realtime.callStatusUpdated() → emits to browser via Socket.IO

Browser side (watchRecordingDownload)
  → Polls GET /api/numbers/:id/calls/by-intent/:intentId every ~5 seconds
  → When CallRecording.status = COMPLETED
  → Fetches GET /api/numbers/:numberId/calls/:callId/recordings/:recordingId/media
  → Auto-downloads the MP3
```

### 14.3 Recording Download

**File:** `apps/web/src/lib/recording-downloads.ts`

The `watchRecordingDownload()` function is invoked after a call ends. It:

1. Polls for the call record using `findByOutboundIntent`.
2. Waits for a recording with status `COMPLETED`.
3. Fetches the MP3 via the backend proxy.
4. Triggers a browser download using a blob URL.

The polling has a backoff and a deadline (based on `intentExpiresAt`). If no recording appears within the window, polling stops silently.

**Weakness**: The auto-download is triggered regardless of whether the user wants it. There is no UI to manage recordings — they simply auto-download. For long calls, this can be hundreds of megabytes auto-downloading without warning.

### 14.4 Dual-Channel Recordings

The `channels=2` setting creates separate audio tracks for each side of the conversation. This is better than mono for transcription and analysis. However, the current system does not offer any transcription or analysis — the dual-channel recording just downloads as-is.

---

## 15. Realtime Feedback

### 15.1 Socket.IO Events for Calls

The `RealtimeService` emits Socket.IO events from both `persistOutboundStart()` and `handleStatus()`:

| Event                   | When                                                             |
| ----------------------- | ---------------------------------------------------------------- |
| `call.outbound.started` | When the TwiML webhook fires and the call is persisted           |
| `call.status.updated`   | On every status callback (ringing, in-progress, completed, etc.) |
| `call.inbound.ringing`  | On inbound calls (separate flow)                                 |

The browser uses `useRealTimeCalls()` hook to update the TanStack Query cache when these events arrive, keeping the calls list current without polling.

### 15.2 Limitations

The `call.outbound.started` event comes from the `persistOutboundStart()` background task — which is fire-and-forget. If that task fails, the realtime event is also lost. The browser's main call flow (the `Device.connect()` path) is not dependent on this event, but the call list view may not update until the next status callback.

There is no realtime event emitted when the `OutboundCallIntent` is created (step 3 of the flow). The only realtime feedback the user gets before the call connects is the SDK's own state changes (pending → ringing → open).

---

## 16. Strengths

### 16.1 The Outbound Intent Pattern Is Architecturally Excellent

The `OutboundCallIntent` pattern is the standout design decision in the entire system. It converts a stateless Twilio webhook call into a server-authorized transaction. The caller ID is locked before the browser ever touches `Device.connect()`. The destination is locked. The identity is locked. The intent can only be consumed once. This is significantly more secure than most browser-based softphone implementations, which simply pass `To` and `callerId` as unverified TwiML parameters.

The atomic consumption using `updateMany` with `consumedAt: null` is correct and concurrency-safe at the database level. Unlike application-level locks, this approach works correctly even if two webhook invocations arrive simultaneously.

### 16.2 No Twilio Secrets in the Browser

The credential isolation is complete and properly enforced. The browser only receives a Voice Access Token — a scoped JWT that expires in an hour and can only be used to interact with one TwiML App. The Account SID, Auth Token, API Key, and TwiML App SID never appear in any frontend bundle or API response. The bundle has been explicitly audited for this.

### 16.3 Comprehensive Webhook Deduplication

The `WebhookEvent` table with unique `dedupeKey` values prevents every form of Twilio's retry-induced duplication:

- Duplicate status callbacks for the same `(CallSid, CallStatus)` pair are ignored.
- Duplicate recording callbacks for the same `(RecordingSid, RecordingStatus)` pair are ignored.
- Duplicate inbound voice webhooks for the same `CallSid` are ignored.

Combined with the status rank guard (prevents regression from COMPLETED back to IN_PROGRESS), this makes the call state machine robust to out-of-order delivery.

### 16.4 Strong Webhook Signature Validation

`TwilioSignatureGuard` validates every webhook before any business logic runs. The guard runs at the NestJS guard layer — it does not touch the database. Unsigned or mis-signed requests never reach Prisma. The round-trip test suite (`twilio-signature.roundtrip.test.ts`) tests all relevant edge cases: valid, invalid, missing, tampered body, wrong URL.

### 16.5 Rich Device Lifecycle Management

The `useVoiceDevice` hook's device lifecycle management is sophisticated and well-thought-out:

- Exponential backoff with a proven ceiling at 8 retries.
- Token refresh scheduled 60 seconds before expiry.
- Separate handling of token rejection vs. transient signaling drops.
- Tab visibility and online/offline recovery.
- Android earpiece routing for mobile calls.
- Protection against stale Device instances leaking across number switches.

This level of detail in a browser softphone is unusual and addresses many production reliability issues.

### 16.6 Multi-Region Edge Failover

The device config includes three Twilio signaling edges: `['frankfurt', 'dublin', 'ashburn']`. If the Frankfurt edge is unreachable, the SDK automatically tries Dublin, then Ashburn. Combined with the reconnect logic in the hook, this means transient regional Twilio outages are handled without user intervention.

### 16.7 Opus Codec Preference

Requesting Opus before PCMU is the correct choice for voice quality. Opus supports adaptive bitrate, forward error correction, and handles packet loss significantly better than PCMU. On mobile networks or poor WiFi, this can mean the difference between an intelligible and unintelligible call.

### 16.8 Live Caller ID Validation

Checking the Twilio `IncomingPhoneNumber` resource before creating the intent catches drift between the local database and Twilio's inventory. If a number was released directly through the Twilio console (bypassing the app), the system catches it at call time and deactivates the local record rather than producing a confusing Twilio error mid-call.

### 16.9 Repeat-Dial Protection

The `findLastDial()` check and confirmation dialog is a thoughtful UX feature. It prevents users from accidentally calling the same number twice in quick succession, which is a common mistake in high-volume outbound calling workflows.

### 16.10 Comprehensive Audit Trail

Every step from token issuance to call hangup produces an `AuditLog` entry with actor identity, IP, user agent, and metadata. This provides a full forensic trail of who placed which call to which number and when. The audit log is append-only and cannot be retroactively modified through the application.

### 16.11 DSCP Packet Marking

Enabling `dscp: true` in the device config marks RTP packets with DSCP EF (Expedited Forwarding). On networks that respect DSCP (enterprise WiFi, some ISPs), this gives voice packets priority over bulk data, reducing jitter and latency.

### 16.12 Real-Time Call Quality Visibility

Exposing `rttMs`, `jitterMs`, `packetLossPct`, `mos`, and `codec` during a live call gives the user (and support staff) actionable visibility into call quality. Most consumer softphones do not expose this level of detail.

---

## 17. Weaknesses and Problems

### 17.1 The 2-Minute Intent TTL Can Silently Fail

When `prepareOutbound()` is called, the intent's `expiresAt` is set to `now + 2 minutes`. If there is any significant delay between this call and Twilio firing the TwiML App webhook, the intent expires and the call silently fails with a TwiML `<Hangup>`.

Scenarios where this can happen:

- Slow network causing `Device.connect()` to take more than 2 minutes to reach Twilio.
- High Twilio API latency (rare but happens during incidents).
- The user prepares a call, gets distracted, and dials 2+ minutes later (unlikely but possible).
- Twilio webhook retries after an initial failure arrive after the TTL.

The user sees a silent disconnection with no explanation. The error is logged server-side as `voice.outbound.rejected` with reason `invalid_or_expired_intent`, but the frontend only receives a hangup from the SDK, not an error message explaining why.

**Fix**: Extend the TTL to 5–10 minutes, or provide a mechanism to refresh the intent. Add a specific error message in the frontend when the call disconnects immediately after connecting.

### 17.2 The Live Twilio Check Is a Synchronous Bottleneck

`assertTwilioCallerIdUsable()` makes a synchronous REST call to Twilio before every outbound call. This:

- Adds ~100–500 ms latency to every call setup.
- Has no retry logic — if the request times out, the entire call preparation fails.
- Has no caching — the same number could be validated many times per minute.
- Creates a hard dependency on Twilio's REST API availability for outbound calling.

If Twilio's REST API is slow or experiencing issues, users cannot place calls even though the Voice infrastructure itself may be fine.

**Fix**: Cache the result for 30–60 seconds per number ID. Use a background sync job to detect drift rather than a hot path check. Fall through to a soft warning rather than a hard failure for non-critical checks.

### 17.3 No Cleanup of Expired OutboundCallIntents

The `OutboundCallIntent` table grows indefinitely. Every time a user opens the dial page and starts typing, every time a call preparation is abandoned, a row is created. Since the `expiresAt` index exists but no cleanup job runs against it, the table will accumulate rows over time.

At low call volumes (a few hundred calls per day), this is not immediately dangerous, but it will degrade query performance over months and create unnecessary storage costs.

**Fix**: Add a scheduled cleanup job that deletes intents older than 24 hours. NestJS's `@nestjs/schedule` module can run this as a cron job.

### 17.4 Recording Downloads Are Automatic and Unbounded

When `recordCall = true` (the default), every call automatically downloads its MP3 to the user's browser when it ends. There is no UI to opt out of individual downloads, manage existing recordings, or set a maximum recording length.

For a 60-minute call, a dual-channel MP3 can easily be 50–100 MB. Auto-downloading this without user confirmation is poor UX and can be disruptive on metered connections.

The recording URL stored in `CallRecording.recordingUrl` points to Twilio's API, but the media is proxied through the backend — meaning the entire file is buffered in server memory before being sent to the browser. On a small server, this can exhaust available RAM.

**Fix**: Show a download button rather than auto-downloading. Stream the recording from the backend instead of buffering. Add a recording duration limit (e.g., 30 minutes).

### 17.5 Background Outbound Start Is Fire-and-Forget

`persistOutboundStart()` is called with `void` — it is not awaited, and its errors are swallowed:

```typescript
void this.persistOutboundStart({ ... });
```

If this fails (e.g., a database timeout), the `Call` row is never created. Status callbacks that arrive before the row exists will create it themselves, but they only have status-callback data — not the `browserIdentity`, `selectedCallerId`, or `destinationE164` that come from the intent.

In practice this means some outbound call records may be missing their caller ID and destination fields.

**Fix**: Await the persistence, or use a queue (Redis-backed Bull) to ensure reliable background processing.

### 17.6 The useVoiceDevice Hook Is a God Object

`use-voice-device.tsx` is 1,000+ lines and manages: Device creation, registration, reconnection, token refresh, call lifecycle, DTMF, mute, audio constraints, mic permissions, Android routing, tab visibility recovery, and an unhandled rejection handler. This is a maintenance burden.

The module-level singleton pattern means state is shared across all component instances. While this is intentional (one Device per browser), it makes testing extremely difficult — there is no way to reset the runtime between tests without re-importing the module.

**Fix**: Split the hook into sub-modules: `useDeviceLifecycle`, `useCallActions`, `useCallQuality`. Use a factory pattern or context to enable test isolation.

### 17.7 No Call Hold or Transfer

The dial feature has no call hold, warm transfer, or cold transfer capability. In professional softphone use cases, these are table-stakes features. The absence means the app cannot be used in call center-like workflows.

These features require TwiML `<Conference>` or Twilio's REST API `calls.update()` to redirect a live call, neither of which is implemented.

### 17.8 Twilio SDK Version Is Patched and Outdated

The installed version is `@twilio/voice-sdk@2.18.4` with a patch file at `patches/@twilio__voice-sdk@2.18.4.patch`. The code comments explicitly acknowledge that 2.18.5 fixed a bug being worked around by the `unhandledrejection` handler.

Running a patched, non-current SDK version creates maintenance risk: the patch must be manually updated with each SDK upgrade, and bugs in 2.18.4 that are fixed in later versions will continue to affect users until the upgrade is made.

### 17.9 No Graceful Degradation for Non-WebRTC Browsers

The app detects WebRTC support and shows a warning, but there is no fallback. On browsers without WebRTC support — older Chromium-based browsers, some mobile browsers, Firefox with media disabled — the dial feature simply does not work.

There is no PSTN callback fallback ("call me at this number") that would let non-WebRTC users still make outbound calls.

### 17.10 Clipboard API Requires HTTPS and User Gesture

The "Paste and Call" feature uses `navigator.clipboard.readText()`, which:

- Requires HTTPS (not available over HTTP).
- Requires a user gesture (the button click satisfies this).
- Is not available in all browsers (Firefox has partial support).
- Requires clipboard permission in some browser/OS combinations.

When it fails, the error is surfaced in the UI, but the feature silently becomes unavailable in some environments without any indication.

---

## 18. Limits and Constraints

### 18.1 Twilio Concurrency Limits

The system is constrained by Twilio account-level concurrency limits:

- Twilio Trial accounts: 1 concurrent call.
- Twilio paid accounts: limited by account type and voice region.
- No built-in concurrency tracking in the app — there is no check before placing a call to see whether you are already at your Twilio concurrency limit.

If the limit is reached, the call will fail at the Twilio level, and the app will show a generic SDK error without indicating the actual cause.

### 18.2 One Device Per Browser Identity

The architecture supports one active Twilio `Device` per browser identity (`user_<userId>_number_<numberId>`). If the same number's dial page is open in two tabs:

- Both tabs share the same identity.
- The second tab's `Device.connect()` will likely conflict with the first.
- The docs explicitly warn: "Do not keep multiple dial/answer tabs open for different numbers in the same browser profile."

There is no enforcement mechanism — no server-side check prevents two sessions from using the same identity simultaneously.

### 18.3 Single-Owner Architecture

The system was designed for a single owner. The RBAC system has `OWNER`, `ADMIN`, `OPERATOR`, and `VIEWER` roles, but the dial feature is owner-only in practice:

- Number ownership is checked against `userId` in all outbound flows.
- There is no concept of a "shared number" that multiple users can dial from.

For multi-user call center deployments, the entire ownership model would need to change.

### 18.4 US-Centric Phone Number Normalization

`normalizeDialablePhoneNumber()` handles US numbers (10-digit and 11-digit with `1` prefix) as a special case, automatically prepending `+1`. International numbers must be entered in full E.164 format. The `defaultCountry` is configurable via `TWILIO_DEFAULT_COUNTRY` but the normalization logic itself is US-biased.

### 18.5 No Call Queue

Outbound calls are placed immediately and in isolation. There is no queuing mechanism for scheduling multiple outbound calls sequentially, pacing calls to respect calling hours, or managing a campaign. Each call is independent.

The AI call feature (`ai-calls` module) has its own queue separate from the manual dial feature — but the manual dial has none.

### 18.6 Intent Consumption Is PostgreSQL-Only

The atomic intent consumption relies on a PostgreSQL `updateMany` with a conditional `WHERE`. This is correct for PostgreSQL but would need different handling in other databases. More importantly, it means that if the webhook fires before the original `prepareOutbound()` HTTP response has been committed to the database (extremely unlikely but theoretically possible with network partitions), the intent lookup will fail.

### 18.7 Recording Limited to Twilio's Infrastructure

Recordings are stored by Twilio, not on the app's own storage. Twilio's free tier stores recordings for 90 days; paid accounts can configure longer retention or export. The app has no mechanism to export recordings to its own storage (S3, etc.) before they expire.

If Twilio's recording URL becomes unavailable (expired, deleted, account suspended), the `recordingUrl` in the database becomes a dead link and the media proxy will fail.

### 18.8 No International Calling Configuration

There is no per-number or per-user control over which international destinations can be dialed. Twilio accounts have geographic permission settings, but the app has no UI or configuration for managing them. Users who try to call international numbers will receive Twilio errors that may be cryptic.

---

## 19. Bottlenecks

### 19.1 Twilio REST API in the Preparation Hot Path

The `prepareOutbound()` endpoint makes a synchronous `IncomingPhoneNumber.fetch()` REST call to Twilio. This is on the direct path between the user clicking "Call" and the call connecting. Any Twilio REST API latency (typically 100–400 ms, occasionally higher) directly delays the call setup.

Under normal conditions this adds ~200 ms. During Twilio incidents affecting the REST API, it can add seconds and eventually fail entirely.

**Measurement**: This bottleneck is not currently observable from within the app — there are no timing metrics on the Twilio validation step. The structured logger records requests at the HTTP layer but not sub-operation latencies.

### 19.2 Serverless Database Cold Starts

The database is Neon (PostgreSQL serverless). Neon's free tier and some paid tiers auto-suspend after a period of inactivity. A cold start can add 500 ms to several seconds to the first database query after suspension.

In the outbound call path, multiple database operations happen:

- `PhoneNumber` lookup (ownership check)
- `IncomingPhoneNumber.fetch()` (Twilio, not DB)
- `VoiceIdentity` upsert
- `OutboundCallIntent` create
- `AuditLog` create

If Neon is in cold-start state when the user clicks "Call", the 2-minute intent TTL begins counting while the database is waking up, eating into the available window.

### 19.3 Redis in Status Callback Deduplication

Every incoming webhook checks the `WebhookEvent` table in PostgreSQL for deduplication. This is a database read on every status callback. Under heavy call volume (hundreds of concurrent calls), this becomes a bottleneck.

The alternative would be Redis-based deduplication (SET with NX and TTL), which would be much faster and reduce PostgreSQL load. Redis is already in the stack (used for rate limiting) but is not used for webhook deduplication.

### 19.4 Recording Download Memory Buffering

`twilio.fetchRecordingMedia()` uses `response.arrayBuffer()` — it downloads the entire recording into memory before serving it. On a small VM (e.g., Fly.io 256 MB machine), a 50 MB recording would consume 20% of available memory, and concurrent recording downloads could exhaust it.

### 19.5 No Connection Pooling at the Webhook Layer

The Twilio webhooks arrive at the API as HTTP POST requests. Each webhook creates at least one database query (the deduplication check). Twilio can send many webhooks in rapid succession for high-volume call periods. If the database connection pool is exhausted (Prisma's default pool size is based on the platform's CPU count), webhooks will queue behind the pool.

Neon's connection limits are also relevant — the serverless tier has strict connection limits that can be exhausted by a busy API under sustained load.

### 19.6 SDK Dynamic Import on First Call

The Twilio Voice SDK is imported dynamically:

```typescript
const sdkPromise = import('@twilio/voice-sdk');
```

On the first visit to the dial page, the browser downloads, parses, and executes the 180 KB SDK bundle. This adds several hundred milliseconds on slow connections. Subsequent visits use the cached bundle, but the first call on a cold browser session has this overhead.

---

## 20. Security Vulnerabilities and Insecurities

### 20.1 Voice Token JWT in localStorage

The owner JWT (the app's auth token) is stored in `localStorage` via Zustand's `persist` middleware. The Voice Access Token is held in memory (the runtime singleton). However, both are accessible to any JavaScript running on the page.

If an XSS attack were possible, both tokens would be exfiltrated. The app uses `helmet` for CSP defaults, but:

- No explicit `Content-Security-Policy` header is configured beyond Helmet's defaults.
- The Cloudflare Pages `_headers` file is in the repo but its CSP settings were not examined.

**Risk**: Medium — XSS would require a vulnerability in the React app or a compromised CDN asset. The `closeProtection: true` setting in the device config limits the window for misuse during an active call, but it does not protect the token itself.

### 20.2 No Rate Limiting on Webhook Endpoints

The Twilio webhook endpoints opt out of rate limiting:

> "Webhook routes opt out (Twilio retries on transient failures and we don't want to drop legitimate traffic)"

This means anyone who can send POST requests to the webhook URLs — even without valid Twilio signatures — generates database writes (the signature guard rejects before DB access, but the guard itself has overhead). A sustained flood of spoofed webhook requests would:

- Generate many failed signature validation attempts.
- Potentially exhaust the database connection pool with guard-layer queries.

**Mitigation present**: Cloudflare's DDoS protection is in front of the API (domain on Cloudflare). Webhook endpoints reject invalid signatures in the guard before DB access.

**Gap**: No explicit rate limit or IP-level blocking on the webhook path.

### 20.3 The outboundIntentId Is Transmitted via Twilio

The `outboundIntentId` is passed as a TwiML parameter from the browser to Twilio and back to the server:

```typescript
device.connect({
  params: {
    selectedNumberId: prepared.selectedNumberId,
    destinationNumber: prepared.destinationNumber,
    outboundIntentId: prepared.outboundIntentId, // exposed to Twilio
  },
});
```

Twilio receives this value and passes it back in the webhook POST body. Twilio's security posture is trustworthy, but this means:

- The intent ID is visible in Twilio's console logs and debugger.
- Twilio's data retention policies apply to this ID.
- If the Twilio account is compromised, an attacker could see all recent intent IDs — though consumed ones are useless and expired ones cannot be reused.

**Risk**: Low — intent IDs are UUIDs with a 2-minute TTL and single-use semantics. Exposure to Twilio's infrastructure is acceptable.

### 20.4 Lazy TwilioService Initialization

```typescript
get client(): Twilio {
  if (!this.clientInstance) {
    this.clientInstance = twilio(this.accountSid, this.authToken);
  }
  return this.clientInstance;
}
```

If `TWILIO_ACCOUNT_SID` or `TWILIO_AUTH_TOKEN` are empty strings (set but empty) rather than truly missing, the `get accountSid()` getter throws ("TWILIO_ACCOUNT_SID is required"), but the Twilio client would be constructed with empty credentials if it had gotten that far. This would create a client that silently uses empty credentials and only fails at the first API call.

**Risk**: Low — the getters throw on empty/missing values, preventing client construction.

### 20.5 No Token Revocation Path

Voice Access Tokens are JWTs with a 1-hour TTL. There is no revocation mechanism:

- If a token is leaked, it remains valid until it expires.
- If a user changes their password (which invalidates the session JWT), the Voice Access Token remains valid for up to 1 hour.
- There is no blocklist for Voice Access Tokens.

**Risk**: Medium — 1-hour window is relatively short, but a stolen token could be used to place calls from the victim's number within that window.

### 20.6 Caller ID Cannot Be Verified by the Recipient

From the PSTN recipient's perspective, the incoming call shows the Twilio number's E.164 as the caller ID. This is expected behavior for a softphone. However:

- There is no STIR/SHAKEN implementation (caller ID attestation).
- Calls from Twilio numbers may be marked as "Suspected Spam" by carriers without proper attestation.
- The app has no UI for registering the business identity needed for STIR/SHAKEN attestation.

**Risk**: Operational — calls may have low deliverability/answer rates in markets where STIR/SHAKEN is common (US, Canada).

---

## 21. Needs and Missing Features

**Implementation update (2026-09-24):** 21.1, 21.5, 21.6, 21.7, and 21.10
are complete. Expired intents are purged on a timer; caller-ID validation uses
a 60-second Redis cache; recording proxy responses stream; intents last five
minutes; and Redis accelerates completed-webhook deduplication while the
database remains the durable audit record. Call recordings are also available
for playback and download in the call log and dashboard, although the dial
screen still offers automatic download when a recording becomes ready. Hold,
transfer, STIR/SHAKEN, shared-number permissions, scheduling, and PSTN
callback fallback remain open work.

### 21.1 Intent Cleanup Job

**Priority: High**  
A scheduled job to delete expired, unconsumed `OutboundCallIntent` rows. Without it, the table grows indefinitely.

```typescript
// Suggested: delete intents older than 24 hours
await prisma.outboundCallIntent.deleteMany({
  where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
});
```

### 21.2 Call Hold

**Priority: High for professional use**  
The ability to place an active call on hold (`<Conference>` with `waitUrl`, or muting the call while playing hold music). This requires changes to the TwiML generation and a new REST endpoint to manipulate the live call.

### 21.3 Recording Management UI

**Priority: High**  
A page listing recordings (from the `CallRecording` table), with per-recording download buttons and the ability to delete/expire recordings from Twilio. Currently, recordings auto-download at call end with no UI for managing them.

### 21.4 Call Transfer

**Priority: Medium**  
Warm transfer (consult, then bridge) and cold transfer (blind) require Twilio's `calls.update()` API to redirect a live call to a new TwiML URL. Not implemented.

### 21.5 Twilio REST API Result Caching

**Priority: Medium**  
Cache the `IncomingPhoneNumber.fetch()` result in Redis (TTL: 60 seconds) to avoid adding Twilio REST API latency to every call preparation. Invalidate on `POST /api/numbers/:id/sync`.

### 21.6 Streaming Recording Proxy

**Priority: Medium**  
Replace `response.arrayBuffer()` with streaming so large recording files don't exhaust server memory. Use Node.js streams or `Response.body` piping.

### 21.7 Intent Expiry Extension or Re-preparation

**Priority: Medium**  
Add a mechanism for the frontend to refresh or extend an intent that is about to expire before the call connects. Or extend the default TTL to 5–10 minutes.

### 21.8 Multi-Number Per User

**Priority: Medium**  
Allow operators/admins to dial from shared pool numbers without requiring OWNER role. This requires revising the `assertOwnership()` logic to support shared numbers.

### 21.9 STIR/SHAKEN Attestation

**Priority: Low-Medium**  
Register for Twilio's STIR/SHAKEN caller ID attestation to improve call deliverability and reduce "Suspected Spam" labeling. Requires Twilio Trust Hub onboarding.

### 21.10 Redis-Based Webhook Deduplication

**Priority: Low-Medium**  
Move webhook deduplication from PostgreSQL to Redis (`SETNX` with TTL). Reduces database load and is faster. Redis is already in the stack.

### 21.11 Call Notes

**Priority: Low**  
The `POST /api/calls/:callId/notes` endpoint exists but stores notes in the audit log rather than a dedicated `CallNote` table. There is no UI to view or edit call notes.

### 21.12 Scheduled Outbound Calls

**Priority: Low**  
A cron-based mechanism to schedule a call for a specific time. Useful for follow-up calls and time-zone-aware outbound campaigns.

### 21.13 PSTN Callback Fallback for Non-WebRTC Browsers

**Priority: Low**  
"Call me at this number" fallback for browsers without WebRTC. Requires a new Twilio REST API call to initiate a server-side call that bridges the user's phone with the destination.

---

## 22. Enhancement Suggestions

**Implementation update (2026-09-24):** The actions in 22.1–22.8 and 22.10
were assessed against the current softphone and are complete: five-minute
single-use intents, an expiry response, 60-second caller-ID validation cache,
intent retention cleanup, streamed recording delivery, Redis hot-path webhook
deduplication with database fallback, startup credential validation, a
one-hour call cap, per-number outbound outcome analytics, and Voice SDK
2.18.5. The sections below retain the original rationale for those changes.

### 22.1 Extend Intent TTL to 5 Minutes

**Effort**: Trivial (change one constant)  
**Impact**: High — eliminates silent call failures on slow networks.

Change `OUTBOUND_INTENT_TTL_MS` from `2 * 60 * 1000` to `5 * 60 * 1000`. The security impact is minimal — the atomic consumption and identity validation still protect against replay attacks.

### 22.2 Add a Specific Error for Intent Expiry

**Effort**: Small  
**Impact**: High — improves user experience significantly.

The SDK currently gives a generic disconnect event when the intent expires. Add a Twilio `<Say>` message in the hangup response:

```typescript
function hangupTwiml(message: string, code?: string): string {
  const response = new twilio.twiml.VoiceResponse();
  if (message) response.say({ voice: 'alice' }, message);
  if (code) response.pause({ length: 0 }); // Attach custom param
  response.hangup();
  return response.toString();
}
```

Or add a `X-Error-Reason` header to the webhook response that the frontend can interpret.

### 22.3 Cache the Twilio Caller ID Validation

**Effort**: Small  
**Impact**: High — removes 100–400 ms from every call setup.

```typescript
private async assertTwilioCallerIdUsable(actor, phoneNumber) {
  const cacheKey = `twilio:number:${phoneNumber.id}:valid`;
  const cached = await this.redis.get(cacheKey);
  if (cached === 'true') return; // Skip validation

  // ... existing validation logic ...

  await this.redis.set(cacheKey, 'true', 'EX', 60); // Cache for 60 seconds
}
```

### 22.4 Stream Recording Downloads

**Effort**: Medium  
**Impact**: High — eliminates memory exhaustion risk for large recordings.

```typescript
async getRecordingMedia(...): Promise<{ stream: Readable; contentType: string; filename: string }> {
  const response = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
  return {
    stream: Readable.fromWeb(response.body),
    contentType: response.headers.get('content-type') ?? 'audio/mpeg',
    filename: `${recording.twilioRecordingSid}.mp3`,
  };
}
```

The controller would then use `@nestjs/common`'s `StreamableFile` to pipe the response.

### 22.5 Move Deduplication to Redis

**Effort**: Medium  
**Impact**: Medium — reduces PostgreSQL load at scale.

Replace the `WebhookEvent` deduplication query with:

```typescript
const key = `webhook:processed:${dedupeKey}`;
const wasNew = await this.redis.set(key, '1', 'NX', 'EX', 86400); // 24h TTL
if (!wasNew) return; // Already processed
```

The `WebhookEvent` table can still exist for auditing but would not be on the hot path.

### 22.6 Add Startup Validation for Twilio Credentials

**Effort**: Small  
**Impact**: Medium — catches misconfiguration at startup rather than first call.

```typescript
// In TwilioService, add:
async onModuleInit() {
  const valid = await this.validateCredentials();
  if (!valid) {
    this.logger.error('Twilio credentials are invalid or TwiML App is misconfigured. Calls will fail.');
  }
}
```

NestJS's `OnModuleInit` lifecycle hook ensures this runs at startup.

### 22.7 Add Call Duration Limit

**Effort**: Small  
**Impact**: Medium — prevents unexpectedly large Twilio bills and recordings.

In `handleOutbound()`, add `<Dial timeout="..." timeLimit="...">`:

```typescript
const dial = response.dial({
  callerId: phoneNumber.phoneNumberE164,
  answerOnBridge: true,
  timeLimit: 3600, // 1-hour maximum call duration
  ...
});
```

`timeLimit` is a Twilio TwiML attribute that auto-terminates calls after the specified seconds. This prevents runaway calls from accumulating charges and creates unexpectedly large recordings.

### 22.8 Add Outbound Call Analytics

**Status: Implemented on 2026-09-24.**

`GET /api/numbers/:numberId/calls/analytics?days=7..90` now returns a
per-number rolling aggregate from the application's webhook-backed call log.
The dial screen displays its 30-day view without adding a Twilio REST call to
the outbound setup path. It returns:

- Total outbound calls (last 7/30 days)
- Average duration
- Connect rate (calls answered vs. total)
- Failure breakdown (busy, no-answer, failed)

Average call quality (MOS, RTT, packet loss) still needs a dedicated
`CallMetric` ingestion pipeline backed by Voice Insights or browser SDK
telemetry. It should be added only after defining retention, aggregation, and
operator access requirements for that more sensitive operational data.

### 22.9 Implement Call Hold via Twilio Conference

**Effort**: Large  
**Impact**: High for professional use cases.

The implementation would:

1. Create a Twilio Conference room on hold request.
2. Move the active call into the conference via `calls.update({ url: conferenceUrl })`.
3. Play hold music via the conference's `waitUrl`.
4. On resume, move the call back to the original `<Dial>` context.

This is a significant architectural addition but would make the softphone suitable for more professional use cases.

### 22.10 Upgrade Twilio Voice SDK to Latest

**Effort**: Small-Medium (depending on breaking changes)  
**Impact**: Medium — removes the patched-SDK workaround and gets access to bug fixes.

The comment in `use-voice-device.tsx` explicitly notes that 2.18.5 fixed the bug being worked around by the `unhandledrejection` handler. Upgrading would allow removing the `patches/` file and the workaround handler. Check for breaking changes in the SDK changelog first.

### 22.11 Add Call Whisper / Barge-In

**Effort**: Large  
**Impact**: Low for current use case, High for call center use cases.

Using Twilio's `<Dial><Conference>` with supervisor roles, an admin could listen to a live call (whisper) or join it (barge-in). This would require a new conference-based TwiML architecture rather than the current `<Dial><Number>` approach.

### 22.12 DTMF IVR Menu Logging

**Effort**: Small  
**Impact**: Medium for support/debugging.

Currently, DTMF tones sent during a call are displayed on screen (last 24 tones) but not persisted. Adding a `tones` field to `Call` (or a separate `CallDtmfEvent` table) would allow reconstructing what IVR menu paths the user navigated during a call.

### 22.13 Automatic Number Rotation for High-Volume Calling

**Effort**: Medium  
**Impact**: High for outbound campaigns.

Add a "number pool" concept where outbound calls rotate across multiple provisioned numbers to distribute carrier reputation and avoid rate limits. This would require modifying `prepareOutbound()` to accept an optional pool ID and select numbers in round-robin or least-used order.

### 22.14 Per-Number International Calling Controls

**Effort**: Medium  
**Impact**: Medium for multi-number deployments.

Add a `allowedDestinationPatterns` field to `PhoneNumber` (a JSON array of E.164 prefixes or regex patterns). The `prepareOutbound()` validation would check the destination against these patterns before creating the intent. This would prevent accidental international calls from domestic-only numbers.

---

## 23. Conclusion

The softphone dial feature in `pstn-twilio` is a mature, security-focused implementation of browser-based outbound PSTN calling via Twilio. Its defining architectural achievement is the `OutboundCallIntent` pattern, which transforms a potentially insecure "dial to any number with a stolen token" attack surface into a server-authorized, locked, single-use, audited transaction. This is non-trivial work that reflects careful thinking about the Twilio security model.

The backend is well-structured. NestJS modules have clear responsibilities. Webhook deduplication is correct. Signature validation is complete and tested. The audit trail is thorough. The device configuration choices (Opus codec, multi-region edges, DSCP marking) reflect genuine audio quality knowledge.

The frontend's `useVoiceDevice` hook is impressive in its handling of reconnection, token refresh, Android audio routing, and tab visibility recovery — areas where most softphone implementations fail in the field. The dial page's UX is thoughtful: readiness status pills, mic permission prompts, repeat-dial warnings, real-time call quality metrics, and in-call DTMF are all above average.

The operational safeguards identified in the original review are now in place.
Outbound authorization is a five-minute, single-use transaction; rejected or
expired intents receive an audible reason; a background task removes stale
intents; caller-ID inventory validation is cached in Redis; recording media is
streamed; and every outbound `<Dial>` has a one-hour limit. The dial page also
shows rolling 30-day call volume, answer rate, average duration, and outcome
counts without involving Twilio in the call setup path.

The remaining professional-use gaps are conference-based hold and transfer,
STIR/SHAKEN onboarding, shared-number permissions, scheduled calls, and a
quality-metrics pipeline for MOS, RTT, jitter, and packet loss. Calls and
recordings can already be reviewed from the call log and dashboard, while the
dial screen continues to offer automatic recording download for the selected
call.

Twilio remains the PSTN provider for every call. The caller-ID validation cache
removes its REST request from the usual preparation path, but the architecture
intentionally retains Twilio-specific primitives such as Voice Access Tokens,
TwiML, webhook signatures, and recording APIs. A provider abstraction should
be introduced only if a second carrier is a concrete product requirement.

The next architectural addition should be conference-based call control. It
would establish the state model needed for hold, warm transfer, cold transfer,
and supervisor participation while preserving the existing intent and webhook
security boundaries. Voice Insights or browser telemetry can then populate a
separate quality-metrics store for longer-term performance analysis.

---

_Report generated: 2026-09-24. Based on full codebase analysis of pstn-twilio at commit state September 2026._
