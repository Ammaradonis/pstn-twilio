# Testing

Test pyramid for `pstn-twilio`. Every layer can be run in isolation; CI
runs all of them on every PR.

## Quick commands

```bash
# All workspaces (lint + typecheck + tests)
pnpm typecheck
pnpm test

# Just the API
pnpm --filter @pstn-twilio/api test

# Just the web
pnpm --filter @pstn-twilio/web test

# E2E (Playwright)
pnpm test:e2e
```

## Unit tests

Located beside their source as `*.test.ts` / `*.test.tsx`. Vitest with
`jsdom` for the web, plain Node for the API. Highlights of what's covered:

- `auth/auth.service.test.ts` — login (argon2id), JWT issuance,
  change-password, bootstrap-once guard.
- `webhooks/twilio-signature.guard.test.ts` and
  `webhooks/twilio-signature.roundtrip.test.ts` — sign + verify against
  Twilio's helper, valid / missing / wrong-token / tampered-body /
  wrong-URL cases.
- `webhooks/messaging.service.test.ts` — inbound SMS upsert dedupe,
  status callback mapping, raw payload retention.
- `webhooks/voice.service.test.ts` — inbound TwiML shape + WS emit,
  outbound caller-ID + ownership check, status callback updates and
  dedupe.
- `webhooks/voice-status.mapper.test.ts` — every Twilio call status
  - unknown sentinel + case-insensitive parsing.
- `numbers/numbers.service.test.ts` — search mapping, purchase calls
  Twilio + writes DB row + audits, ownership guard on read/update.
- `messages/messages.service.test.ts` — send path validates E.164,
  ownership, rate-limit-friendly retry, status updates.
- `voice/voice.service.test.ts` — `issueToken` returns a real JWT,
  `prepareOutbound` checks ownership + voice capability + E.164.
- `calls/calls.service.test.ts` — pagination cursor codec, hangup guard,
  audit + realtime emit.
- `diagnostics/diagnostics.service.test.ts` — overall status aggregation,
  HTTPS detection, webhook snapshot last-error.
- `audit-logs/audit-logs.service.test.ts` — cursor encoding, filtering.
- `common/request-id.middleware.test.ts` — UUID minting + malformed-ID
  rejection.

Frontend unit tests:

- `app.test.tsx` — unauth → login redirect, authed → dashboard render,
  404 fallback.
- `lib/auth-store.test.ts` — Zustand persistence, login/logout
  serialization.
- `lib/toast.test.tsx` — toast push + render.

## Integration tests

`webhooks/twilio-signature.roundtrip.test.ts` is a true integration test
of the webhook signature pipeline — it spins up the Nest module, signs a
payload exactly like Twilio does, and verifies the controller is
reachable / unreachable depending on the signature.

For a deeper integration smoke (DB + Redis + HTTP), the same pattern can
be extended with `@nestjs/testing`'s `Test.createTestingModule` to
override `PrismaService` and `RedisService` with `pg-mem` and `ioredis-mock`.

## End-to-end (Playwright)

Located under `apps/web/e2e/`:

- `auth.e2e.test.ts` — login, redirect-back-to-original-route, sign-out.
- `numbers.e2e.test.ts` — search UI, mock-purchase flow, listing.
- `messages.e2e.test.ts` — inbox page, optimistic send, realtime inbound
  update via mocked WebSocket event.
- `smoke.e2e.test.ts` — happy path through dashboard, settings, numbers.

Run against the local dev stack with:

```bash
# In one terminal
pnpm dev

# In another
pnpm test:e2e
```

CI runs Playwright via [`apps/web/playwright.config.ts`](../apps/web/playwright.config.ts)
in a single Chromium worker. Use `pnpm test:e2e --ui` for the headed
debugger.

## Manual Twilio production checklist

Run after every Twilio config change or deploy to a fresh environment.
This requires real Twilio credentials and at least one real number.

See [`MANUAL_TWILIO_CHECKLIST.md`](MANUAL_TWILIO_CHECKLIST.md) for the
itemized form (printable).

1. **Owner login.** `https://app.webfitalchemist.online` → log in.
   Expected: dashboard loads.
2. **Diagnostics green.** `/settings/diagnostics` → all four checks `ok`,
   webhook ingest shows recent events when traffic flows.
3. **Purchase a test number** via `/numbers/new` (Local, +1, voice + SMS).
   Expected: row appears in the table, audit log shows
   `number.purchased`, Twilio Console shows the configured webhook URLs
   on the new number.
4. **Inbound SMS.** Send an SMS from your phone to the test number.
   Expected: inbox shows the message within ~3s without refresh.
5. **Outbound SMS.** From the inbox, send "hello" to your phone.
   Expected: appears as `QUEUED` → `SENT` → `DELIVERED`; phone receives.
6. **Inbound call.** Call the test number from your phone.
   Expected: `/numbers/:id/answer` rings; click _Answer_; two-way audio.
7. **Outbound call.** `/numbers/:id/dial` → dial your phone.
   Expected: phone shows the Twilio number as caller ID; two-way audio.
8. **Call logs.** `/numbers/:id/calls` should show both calls with
   correct direction, duration, and status.
9. **Twilio Console → Monitor → Debugger.** Should be empty (no 4xx/5xx).
10. **Audit log.** `/api/audit-logs` (or `/settings/diagnostics`) should
    show every action above.

## Production launch checklist

See [`LAUNCH_CHECKLIST.md`](LAUNCH_CHECKLIST.md).
