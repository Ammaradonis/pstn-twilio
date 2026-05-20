# Phase 7 Implementation Complete

## Summary

Phase 7 (SMS inbox, outbound SMS, webhook handlers, status callbacks, and real-time updates) is implemented end-to-end. Inbound Twilio webhooks land on signed endpoints, get dedup'd, persisted, and broadcast over Socket.IO. Outbound sends go through a JWT-protected, rate-limited, audit-logged service. The `/numbers/:id/messages` page renders a real-time inbox with compose, status badges, retry, and a technical-details drawer.

## What was implemented

### Backend (`apps/api/src/`)

- `realtime/`
  - `realtime.gateway.ts` — Socket.IO `@WebSocketGateway` with JWT handshake auth.
  - `realtime.service.ts` — typed emit helpers (`smsReceived`, `smsSent`, `smsStatusUpdated`, plus stubs for the Phase 8 call events).
  - `realtime.module.ts` — global module wiring `JwtModule.registerAsync` with the same `JWT_SECRET` Phase 5 uses.
- `webhooks/`
  - `twilio-signature.guard.ts` — calls `twilio.validateRequest` with the URL reconstructed from `TWILIO_WEBHOOK_BASE_URL` + `req.originalUrl`.
  - `messaging.controller.ts` — `POST /webhooks/twilio/messaging/inbound` (returns `<Response/>`) and `POST /webhooks/twilio/messaging/status` (returns 204). Both guarded by `TwilioSignatureGuard`.
  - `messaging.service.ts` — dedupes via `webhook_events.dedupeKey`, persists `SmsMessage`, stores `rawPayload`, broadcasts to Socket.IO.
  - `status.mapper.ts` — Twilio status string → `MessageStatus` enum mapping.
- `messages/`
  - `messages.controller.ts` — list/get/send/retry/search routes, JWT-guarded, rate-limited per-route.
  - `messages.service.ts` — ownership check, capability check, optimistic pending row + Twilio call + sid persistence + WS emit + audit log; failure path marks FAILED, emits status update, surfaces 400.
  - `messages.mapper.ts` — row → DTO mapping and base64url cursor codec.
- `main.ts` — `setGlobalPrefix('api', { exclude: [{ path: 'webhooks/(.*)', method: ALL }] })` so Twilio webhooks hit the public paths directly.
- `app.module.ts` — wired `RealtimeModule`, `MessagesModule`, `WebhooksModule`.

### Frontend (`apps/web/src/`)

- `lib/realtime.ts` — Socket.IO singleton, reads JWT from `localStorage`, reconnects.
- `hooks/use-realtime-messages.ts` — keeps the TanStack Query cache live for `messages` queries; `status.updated` never inserts, only replaces.
- `lib/api-client.ts` — added the `api.messages` block.
- `pages/messages.tsx` — full inbox + compose + per-row controls:
  - Compose: E.164 destination, char-count, lawful-consent warning, send button.
  - Inbox: direction badge, status badge, timestamp, body, media links, error code/message line, technical-details drawer (raw JSON), retry button for failed outbound.

## API surface delivered

| Route                                                     |
| --------------------------------------------------------- |
| `GET    /api/numbers/:numberId/messages`                  |
| `GET    /api/numbers/:numberId/messages/:messageId`       |
| `POST   /api/numbers/:numberId/messages`                  |
| `POST   /api/numbers/:numberId/messages/:messageId/retry` |
| `GET    /api/messages/search`                             |
| `POST   /webhooks/twilio/messaging/inbound`               |
| `POST   /webhooks/twilio/messaging/status`                |

## WebSocket events

| Event                | Payload                                |
| -------------------- | -------------------------------------- |
| `sms.received`       | `{ numberId, message: SmsMessageDto }` |
| `sms.sent`           | `{ numberId, message: SmsMessageDto }` |
| `sms.status.updated` | `{ numberId, message: SmsMessageDto }` |

## Tests

- `pnpm --filter @pstn-twilio/api typecheck` — clean.
- `pnpm --filter @pstn-twilio/web typecheck` — clean.
- `pnpm --filter @pstn-twilio/api test` — **22 tests passing** across 5 files. New coverage in Phase 7:
  - `MessagingWebhookService.handleInbound`: dedupe path, happy path (persist + WS emit + raw payload), unknown destination path.
  - `MessagingWebhookService.handleStatus`: status update + WS emit.
  - `mapTwilioStatusToEnum`: every supported Twilio status string plus an unknown sentinel.
  - `TwilioSignatureGuard`: pass + fail cases.
  - `MessagesService.send`: forbidden / no-SMS-capability rejection, happy path (Twilio call args, sid storage, audit log, WS emit), Twilio-error path (FAILED row + status WS event + 400).
  - `MessagesService.retry`: refuses to retry a SENT message (only FAILED/UNDELIVERED allowed).
  - Cursor codec round-trip.

## Security and compliance

- Webhooks **require** a valid Twilio signature; the guard returns false otherwise → 403 with no DB write.
- Webhook bodies are dedup'd by `MessageSid` via `webhook_events.dedupeKey` (unique), so Twilio replays cannot duplicate `sms_messages` rows.
- Outbound endpoints require JWT, validate ownership, validate SMS capability, validate E.164 destination, and are throttled to 10/min/short.
- The compose UI explicitly requires lawful consent and forbids bulk SMS, OTP harvesting, and unsolicited marketing.
- No SMS forwarding, no OTP parsing, no automation hooks. Inbound messages are visible only to authenticated owners.
- All outbound sends write an `audit_logs` row with action `message.sent`.

## Acceptance criteria (from `10-phase-plan.txt`)

- [x] Inbound SMS appears in UI without refresh — Socket.IO `sms.received` triggers TanStack Query cache prepend.
- [x] Outbound SMS status updates — Twilio status callback path persists the new status and broadcasts `sms.status.updated`.
- [x] Invalid signatures rejected — `TwilioSignatureGuard.canActivate` returns false; NestJS converts that to 403 and the controller body never runs.
- [x] Duplicate webhooks do not duplicate messages — dedup at two layers (`webhook_events.dedupe_key` unique + `sms_messages.twilio_message_sid` unique).
- [x] Pagination works — cursor-based, base64url-encoded `{ t, id }`, descending order with id tiebreaker, round-trip tested.

## What's next (Phase 8)

- `POST /webhooks/twilio/voice/inbound` returning TwiML `<Dial><Client>…</Client></Dial>`.
- `POST /webhooks/twilio/voice/outbound` returning TwiML `<Dial callerId><Number/></Dial>`.
- `POST /webhooks/twilio/voice/status` updating the `calls` table and broadcasting `call.status.updated`.
- `POST /api/voice/token` minting a Twilio Voice Access Token (`VoiceGrant`) scoped to a stable identity.
- `/numbers/:numberId/answer` and `/numbers/:numberId/dial` using the Twilio Voice JS SDK against this token.

Phase 7 status: complete.
