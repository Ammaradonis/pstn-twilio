# Architecture

This document is the canonical reference for how `pstn-twilio` is wired
together. For the historical research that led to this shape, see
[`RESEARCH.md`](RESEARCH.md) and ADR
[`adr/0001-telephony-architecture.md`](adr/0001-telephony-architecture.md).

## High-level diagram

```
                     ┌──────────────────────────────┐
                     │      Browser (Owner UI)      │
                     │  Vite + React + TanStack Q.  │
                     │  Twilio Voice JS SDK         │
                     │  socket.io-client            │
                     └──────────────┬───────────────┘
                                    │ HTTPS  (auth: bearer JWT)
                                    │ WSS    (Socket.IO realtime)
                                    ▼
                     ┌──────────────────────────────┐
                     │   NestJS API (apps/api)      │
                     │   - Auth, Numbers, Messages, │
                     │     Voice, Calls, Webhooks   │
                     │   - Realtime gateway         │
                     │   - Audit log                │
                     └──┬─────────┬─────────┬───────┘
                        │         │         │
              ┌─────────▼─┐  ┌────▼────┐  ┌─▼──────────┐
              │ Postgres  │  │  Redis  │  │  Twilio    │
              │  (Neon)   │  │(Upstash)│  │  REST/SDK  │
              └───────────┘  └─────────┘  └─┬──────────┘
                                            │
                                            │ Webhooks
                                            ▼
                              POST /webhooks/twilio/{...}
                              (signature-verified, server-only)
```

## Workspaces

```
apps/
  api/    NestJS (Express) — owns the database, talks to Twilio, signs Voice JWTs
  web/    Vite + React — owner-only UI, never holds Twilio secrets
packages/
  shared/ Pure TypeScript: DTOs, Zod schemas, enums shared by api and web
scripts/
  twilio-sync.ts  Operational tool: list/import/configure/verify against Twilio
docs/   Markdown-only; this file lives here.
```

## Backend modules (`apps/api/src/`)

| Module     | Responsibility                                                                              |
| ---------- | ------------------------------------------------------------------------------------------- |
| `auth`     | Email/password login (argon2id), JWT issuance, `/auth/me`, change-password, `JwtAuthGuard`. |
| `health`   | `/api/health`, `/api/health/{db,redis,twilio}` — used by the dashboard and uptime probes.   |
| `prisma`   | Single `PrismaService` shared by every module.                                              |
| `redis`    | `RedisService` for ephemeral state (rate-limit windows, voice token rotation, pub/sub).     |
| `twilio`   | `TwilioService` — lazy-initialized SDK client, signature validation, webhook URL helpers.   |
| `numbers`  | Search, purchase, list, get, update, sync, configure-webhooks, release, deactivate.         |
| `messages` | Send SMS, retry SMS, list/search messages. Owner-or-self ownership checks on every read.    |
| `voice`    | Mints short-lived Voice Access Tokens for the browser SDK. No Twilio secrets ever leak.     |
| `calls`    | Outbound prepare, hangup, notes; list per number; status-callback ingestion via webhooks.   |
| `webhooks` | Twilio inbound endpoints + `TwilioSignatureGuard` (HMAC-SHA1 validation).                   |
| `realtime` | Socket.IO gateway. Server emits `sms.*`, `call.*`, `number.*` events to the owner room.     |
| `audit`    | Append-only audit log writer. Every mutation records actor, action, entity, IP, UA.         |
| `common`   | `RequestIdMiddleware`, `HttpLoggerMiddleware`, `ZodValidationPipe`.                         |

Every controller is mounted under `/api` except `/webhooks/twilio/*`, which
intentionally bypasses the global prefix so the URLs Twilio is configured with
match exactly.

## Frontend layout (`apps/web/src/`)

| Path                   | Role                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `app.tsx` / `main.tsx` | Routes, providers (QueryClient, Toast, ErrorBoundary), router.                                            |
| `pages/`               | One file per route — login, dashboard, numbers, messages, calls, dial, answer, settings\*.                |
| `components/`          | Layout (sidebar, switcher, status pills), error boundary, dialer, message list.                           |
| `hooks/`               | `use-realtime-messages`, `use-realtime-calls`, `use-voice-device`, `use-api-health`, `use-socket-status`. |
| `lib/api-client.ts`    | Single typed `fetch` wrapper — bearer-token aware, throws `ApiError`.                                     |
| `lib/auth-store.ts`    | Zustand store with `persist` for the bearer JWT and current user.                                         |
| `lib/realtime.ts`      | Singleton Socket.IO client.                                                                               |
| `lib/toast.tsx`        | Global toaster.                                                                                           |

The web bundle is 100% static and is deployed as a Cloudflare Pages site (or
any other static host). All dynamic data flows through `/api/*` and the
`/socket.io` upgrade.

## Data flow examples

### Inbound SMS

1. PSTN user texts a Twilio number.
2. Twilio POSTs to `https://api.<host>/webhooks/twilio/messaging/inbound`.
3. `TwilioSignatureGuard` validates the `X-Twilio-Signature` HMAC and rejects
   anything that fails (401/403).
4. `MessagingWebhookService` upserts the `SmsMessage` row (idempotent on
   `MessageSid`) and writes an `AuditLog` entry.
5. `RealtimeGateway` emits `sms.received` to the owner's WebSocket room.
6. The browser updates the React Query cache for `['messages', numberId]`,
   which re-renders the inbox without a refetch.

### Outbound voice (PSTN call from the browser)

1. Browser fetches `/api/voice/token` and gets a short-lived JWT scoped to a
   per-number identity (`user_<userId>_number_<numberId>`).
2. `Device.connect({ params: { To: '+1...', selectedNumberId: '<id>' } })`
   — Twilio answers with a TwiML application Voice URL.
3. Twilio POSTs to `https://api.<host>/webhooks/twilio/voice/outbound`.
4. `VoiceWebhookService` resolves the actor from the identity, asserts they
   own `selectedNumberId`, returns TwiML `<Dial><Number callerId>`.
5. Twilio bridges the call and delivers status callbacks to
   `/webhooks/twilio/voice/status`, which update the `Call` row and emit
   `call.status.updated` to the realtime gateway.

## Observability

- **Request ID**: every HTTP request gets `X-Request-Id` via
  `RequestIdMiddleware`. Inbound caller-supplied IDs are accepted only if
  they match `^[A-Za-z0-9._:-]+$` and are ≤ 64 chars.
- **Structured access log**: `HttpLoggerMiddleware` logs one line per request
  with `req_id`, method, path, status, duration, IP, and a truncated UA.
- **Health checks**: `/api/health/{db,redis,twilio}` are independent (a
  Twilio outage does not affect the DB/Redis pills).
- **Audit log**: every mutation goes through `AuditService.log` so we have a
  forensic trail of who provisioned/sent/configured what.

## Security

See [`SECURITY.md`](SECURITY.md). The 30-second summary:

- Argon2id for password hashing, JWTs for session, `helmet` defaults, CORS
  pinned to `WEB_APP_URL`.
- Twilio credentials live only on the API. The browser only ever sees the
  short-lived **Voice Access Token** (different class of secret).
- Every Twilio webhook endpoint is protected by `TwilioSignatureGuard` — any
  request without a valid `X-Twilio-Signature` is rejected before any
  business logic runs.
- Every owner mutation passes through `JwtAuthGuard` and is recorded in the
  audit log.
