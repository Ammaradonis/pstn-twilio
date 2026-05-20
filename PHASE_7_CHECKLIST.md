# Phase 7 — Post-Implementation Checklist

## What ships in this phase

### Backend

- [x] `RealtimeModule` (global) — Socket.IO gateway authenticated with the same `JWT_SECRET` used by Phase 5. `RealtimeService` exposes typed emit helpers (`smsReceived`, `smsSent`, `smsStatusUpdated`, `callInboundRinging`, `callStatusUpdated`, `webhookError`, etc).
- [x] `WebhooksModule` — public endpoints excluded from the `/api` global prefix.
  - `POST /webhooks/twilio/messaging/inbound`
  - `POST /webhooks/twilio/messaging/status`
- [x] `TwilioSignatureGuard` — wraps `twilio.validateRequest`, reconstructs the URL from `TWILIO_WEBHOOK_BASE_URL` + `req.originalUrl`, rejects anything without a matching `X-Twilio-Signature`.
- [x] `MessagingWebhookService` — dedupes by `MessageSid` via the `webhook_events` table, persists the SMS, stores the raw payload, broadcasts `sms.received` / `sms.status.updated`. Returns an empty `<Response/>` to Twilio.
- [x] `MessagesModule` with `MessagesService` + `MessagesController`:
  - `GET /api/numbers/:numberId/messages?cursor&limit` (cursor-paginated, descending by `createdAt`)
  - `GET /api/numbers/:numberId/messages/:messageId`
  - `POST /api/numbers/:numberId/messages` (rate-limited `short`: 10/min)
  - `POST /api/numbers/:numberId/messages/:messageId/retry` (rate-limited)
  - `GET /api/messages/search`
- [x] `main.ts` now excludes `/webhooks/*` from the `/api` global prefix so Twilio can hit the public webhook paths directly.
- [x] Unit tests across `messaging.service`, `twilio-signature.guard`, and `messages.service` (22 tests total passing).

### Frontend

- [x] `apps/web/src/lib/realtime.ts` — singleton Socket.IO client that picks up the JWT from `localStorage` and reconnects automatically.
- [x] `apps/web/src/hooks/use-realtime-messages.ts` — subscribes to `sms.received` / `sms.sent` / `sms.status.updated`, updates the TanStack Query cache in place.
- [x] `apps/web/src/lib/api-client.ts` extended with `api.messages.list/get/send/retry/search`.
- [x] `apps/web/src/pages/messages.tsx` rewritten:
  - Compose panel: E.164 input, body textarea, char counter (1600 max), consent/compliance warning, send button.
  - Inline status badges (queued / sent / delivered / failed / received).
  - Per-message technical details drawer (full JSON, including stored fields).
  - Retry button for failed/undelivered outbound messages.
  - Disabled state + amber banner when the number lacks the SMS capability.

## API surface delivered in Phase 7

| Method | Path                                               | Auth                  | Notes                                        |
| ------ | -------------------------------------------------- | --------------------- | -------------------------------------------- |
| GET    | `/api/numbers/:numberId/messages`                  | JWT                   | Cursor pagination (base64url payload).       |
| GET    | `/api/numbers/:numberId/messages/:messageId`       | JWT                   | Ownership-checked.                           |
| POST   | `/api/numbers/:numberId/messages`                  | JWT                   | Throttled 10/min. Requires SMS capability.   |
| POST   | `/api/numbers/:numberId/messages/:messageId/retry` | JWT                   | Throttled. Only FAILED / UNDELIVERED.        |
| GET    | `/api/messages/search`                             | JWT                   | Filters by query/from/to/direction.          |
| POST   | `/webhooks/twilio/messaging/inbound`               | Twilio signature only | TwilioSignatureGuard. Returns `<Response/>`. |
| POST   | `/webhooks/twilio/messaging/status`                | Twilio signature only | TwilioSignatureGuard. Returns 204.           |

## WebSocket events emitted

- `sms.received` — payload: `{ numberId, message: SmsMessageDto }`
- `sms.sent` — payload: `{ numberId, message: SmsMessageDto }`
- `sms.status.updated` — payload: `{ numberId, message: SmsMessageDto }`

(The frontend cache update handler is event-aware: `sms.status.updated` never inserts a new row, it only updates existing ones.)

## Compliance + safety

- Compose panel explicitly states the user must have lawful consent and forbids bulk SMS, unsolicited marketing, and OTP harvesting.
- No bulk-send endpoint exists; the only outbound path is one recipient per request.
- Inbound messages are stored but only displayed to authenticated owners. There is no auto-forwarding to email, webhooks, or other phone numbers.
- All sensitive mutations write audit log entries (`message.sent`).
- Webhook signature failures return 403 from the guard and are logged with a warning. Invalid bodies are caught and never crash the controller (they're logged and Twilio still gets a 200/204 response so it doesn't retry indefinitely).

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

## Manual smoke test

1. Provision a number via Phase 6 UI.
2. From an external phone, send an SMS to that number.
3. Confirm an `sms.received` row appears in the `/numbers/:id/messages` UI in real time (no refresh).
4. Send an outbound SMS via the compose panel.
5. Confirm the row appears with status `SENT` and transitions to `DELIVERED` when the Twilio status callback arrives.
6. Replay the same inbound webhook from Twilio's "request inspector" — the UI should not duplicate (dedupe via `webhook_events.dedupe_key`).
7. Tamper with the `X-Twilio-Signature` header — the request should return 403 and no DB row should be written.

## Acceptance criteria

- [x] Inbound SMS appears in UI without refresh.
- [x] Outbound SMS status updates (via Twilio status callbacks).
- [x] Invalid signatures rejected (guard returns false → 403).
- [x] Duplicate webhooks do not duplicate messages (`webhook_events.dedupe_key` unique + `sms_messages.twilio_message_sid` unique).
- [x] Pagination works (cursor codec is base64url `{ t, id }` with `(createdAt DESC, id DESC)` ordering; round-trip tested).
