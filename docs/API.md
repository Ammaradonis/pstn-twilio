# HTTP API

All routes are prefixed with `/api` **except** the Twilio webhook routes,
which are intentionally mounted at `/webhooks/twilio/*` so the URLs match
what is configured on each `IncomingPhoneNumber`. Every `/api/*` route except
`/api/auth/login`, `/api/auth/bootstrap-owner`, and `/api/health*` requires a
valid `Authorization: Bearer <jwt>` header.

DTOs and Zod schemas referenced below are defined in
[`packages/shared`](../packages/shared/src) and are the single source of
truth shared by the API and the web client.

## Conventions

- All requests/responses are JSON unless noted otherwise.
- Errors use NestJS's default shape: `{ statusCode, message, error }`.
- All timestamps are ISO-8601 UTC strings.
- Phone numbers are always **E.164** strings, e.g. `+15551234567`.
- The owner role can read any number; non-owner roles can only see their own.

## Auth

| Method | Path                        | Body                                  | Returns                        |
| ------ | --------------------------- | ------------------------------------- | ------------------------------ |
| POST   | `/api/auth/bootstrap-owner` | `{ email, password, bootstrapToken }` | `{ message }` — one-time only. |
| POST   | `/api/auth/login`           | `{ email, password }`                 | `{ token, user }`              |
| POST   | `/api/auth/logout`          | —                                     | `{ message }`                  |
| GET    | `/api/auth/me`              | —                                     | `UserDto`                      |
| POST   | `/api/auth/change-password` | `{ oldPassword, newPassword }`        | `{ message }`                  |

`UserDto = { id, email, role, createdAt, lastLoginAt }`.

## Health

| Method | Path                 | Returns                                        |
| ------ | -------------------- | ---------------------------------------------- |
| GET    | `/api/health`        | `{ status, checks, uptimeSeconds, timestamp }` |
| GET    | `/api/health/db`     | DB-only check                                  |
| GET    | `/api/health/redis`  | Redis-only check                               |
| GET    | `/api/health/twilio` | Validates the Twilio Account SID + Auth Token  |

## Numbers

| Method | Path                                        | Body / Query                        | Returns                       |
| ------ | ------------------------------------------- | ----------------------------------- | ----------------------------- |
| GET    | `/api/phone-number-options/countries`       | —                                   | `CountryOption[]`             |
| GET    | `/api/numbers/available`                    | `NumberSearchInput` as query string | `AvailableNumberDto[]`        |
| POST   | `/api/numbers/purchase`                     | `PurchaseNumberInput`               | `PhoneNumberDto`              |
| GET    | `/api/numbers`                              | —                                   | `PhoneNumberDto[]`            |
| GET    | `/api/numbers/:numberId`                    | —                                   | `PhoneNumberDto`              |
| PATCH  | `/api/numbers/:numberId`                    | `{ friendlyName?, tags?, active? }` | `PhoneNumberDto`              |
| POST   | `/api/numbers/:numberId/sync`               | —                                   | `PhoneNumberDto`              |
| POST   | `/api/numbers/:numberId/configure-webhooks` | —                                   | `PhoneNumberDto`              |
| POST   | `/api/numbers/:numberId/release`            | —                                   | `PhoneNumberDto`              |
| DELETE | `/api/numbers/:numberId`                    | —                                   | `PhoneNumberDto` (deactivate) |

`NumberSearchInput` includes `country` (ISO-3166-1 alpha-2), optional
`areaCode`, `contains`, `inRegion`, `inLocality`, `inPostalCode`, capability
flags `voiceEnabled`/`smsEnabled`/`mmsEnabled`, `pageSize`, and a discriminator
`type` of `local | toll_free | mobile`.

## Messages

| Method | Path                                               | Body / Query                     | Returns                                          |
| ------ | -------------------------------------------------- | -------------------------------- | ------------------------------------------------ |
| GET    | `/api/numbers/:numberId/messages`                  | `?cursor&limit&direction&status` | `{ items: SmsMessageDto[], total, nextCursor? }` |
| GET    | `/api/numbers/:numberId/messages/:messageId`       | —                                | `SmsMessageDto`                                  |
| POST   | `/api/numbers/:numberId/messages`                  | `{ to, body }`                   | `SmsMessageDto`                                  |
| POST   | `/api/numbers/:numberId/messages/:messageId/retry` | —                                | `SmsMessageDto`                                  |
| GET    | `/api/messages/search`                             | `MessageSearchInput`             | `SmsMessageDto[]`                                |

## Calls

| Method | Path                                     | Body / Query                              | Returns                                                                                            |
| ------ | ---------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| GET    | `/api/numbers/:numberId/calls`           | `?cursor&limit&status`                    | `{ items: CallDto[], total, nextCursor? }`                                                         |
| GET    | `/api/numbers/:numberId/calls/last-dial` | `?destination`                            | `LastDialDto \| null`                                                                              |
| GET    | `/api/numbers/:numberId/calls/:callId`   | —                                         | `CallDto`                                                                                          |
| POST   | `/api/calls/prepare-outbound`            | `{ selectedNumberId, destinationNumber }` | `{ outboundIntentId, identity, selectedNumberId, selectedCallerId, destinationNumber, expiresAt }` |
| POST   | `/api/calls/:callId/hangup`              | —                                         | `CallDto`                                                                                          |
| POST   | `/api/calls/:callId/notes`               | `{ note }`                                | `CallDto`                                                                                          |

## Voice (browser softphone)

| Method | Path                       | Body / Query     | Returns                                |
| ------ | -------------------------- | ---------------- | -------------------------------------- |
| POST   | `/api/voice/token`         | `?numberId=<id>` | `{ token, identity, ttl }`             |
| GET    | `/api/voice/identity`      | `?numberId=<id>` | `{ identity }`                         |
| GET    | `/api/voice/device-config` | —                | `{ codecPreferences, edge, logLevel }` |

The voice token is a Twilio Voice Access Token (JWT). It is **scoped to a
single per-number identity** (`user_<userId>_number_<numberId>`) and expires
within an hour. The token never reveals the API Key Secret to the browser.

## Twilio webhooks (server only)

These endpoints are registered with each `IncomingPhoneNumber` and validated
on every request via `TwilioSignatureGuard`. They are never reachable from the
browser app.

| Method | Path                                 | Purpose                                     |
| ------ | ------------------------------------ | ------------------------------------------- |
| POST   | `/webhooks/twilio/voice/inbound`     | TwiML for `<Dial><Client>` to ring browser. |
| POST   | `/webhooks/twilio/voice/outbound`    | TwiML App URL for browser-originated calls. |
| POST   | `/webhooks/twilio/voice/status`      | Twilio status callbacks → DB + WS event.    |
| POST   | `/webhooks/twilio/voice/fallback`    | Fallback TwiML when the primary URL fails.  |
| POST   | `/webhooks/twilio/messaging/inbound` | Persist + emit inbound SMS.                 |
| POST   | `/webhooks/twilio/messaging/status`  | Update outbound SMS status.                 |

## Settings (Phase 10 admin/diagnostics surface)

The `/api/settings/*` group is intentionally minimal and read-only — the app
does not let an owner mutate Twilio credentials at runtime. Anything that
needs to change there belongs in environment variables and a redeploy.

| Method | Path                            | Returns                                                                                                              |
| ------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/settings`                 | Echoes the public, non-secret settings (cookie domain, CORS origins, default country, webhook base URL).             |
| GET    | `/api/settings/twilio/validate` | Calls `TwilioService.validateCredentials()` and reports `ok` or `down`; includes TwiML App outbound Voice URL drift. |

## WebSocket events

The Socket.IO gateway is mounted at the API origin. The browser connects
with the bearer JWT in the `auth` payload and joins a room scoped to the
authenticated user.

| Direction       | Event                            | Payload (summary)               |
| --------------- | -------------------------------- | ------------------------------- |
| server → client | `number.created/updated/deleted` | `PhoneNumberDto`                |
| server → client | `sms.received`                   | `SmsMessageDto`                 |
| server → client | `sms.sent`                       | `SmsMessageDto`                 |
| server → client | `sms.status.updated`             | `SmsMessageDto`                 |
| server → client | `call.inbound.ringing`           | `CallDto`                       |
| server → client | `call.outbound.started`          | `CallDto`                       |
| server → client | `call.status.updated`            | `CallDto`                       |
| server → client | `twilio.webhook.error`           | `{ kind, message, requestId? }` |
| client → server | `voice.device.ready`             | `{ identity }`                  |
| client → server | `voice.device.unavailable`       | `{ identity, reason }`          |

## Authorization

- Every `/api/*` route (except auth login/bootstrap-owner and the health
  endpoints) is guarded by `JwtAuthGuard` and the JWT must have role
  `OWNER` to mutate.
- All mutations pass through `AuditService.log` and are recorded with the
  actor's IP and User-Agent.
- The signature guard runs **before** any DB lookup on webhook routes, so
  unsigned traffic never touches Postgres.

## Rate limiting

`@nestjs/throttler` is configured with two windows: 10 req/min and
100 req/15 min globally. Webhook routes opt out (Twilio retries on transient
failures and we don't want to drop legitimate traffic).
