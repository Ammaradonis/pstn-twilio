# Security

This document describes the security boundaries, threat model, and concrete
controls in `pstn-twilio`. The audience is the operator (you) and any future
auditor.

## Threat model (what we defend against)

| Threat                                                    | Defense                                                                                                               |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Stolen / leaked Twilio credentials                        | Server-only env vars; no credentials in the bundle; restricted Twilio API key with minimum scope.                     |
| Forged Twilio webhooks (someone impersonating Twilio)     | `TwilioSignatureGuard` rejects any request without a valid `X-Twilio-Signature` HMAC.                                 |
| Tampered webhook bodies                                   | Same — the signature covers the URL **and** the form params.                                                          |
| Stolen owner password                                     | Argon2id hashing (memory-hard); login throttled by `@nestjs/throttler`; audit log captures attempts.                  |
| Stolen owner JWT                                          | Tokens are short-lived; `/auth/change-password` and explicit logout invalidate the session.                           |
| XSS exfiltrating tokens                                   | `helmet` CSP defaults; the JWT is in `localStorage` only because we don't run third-party JS.                         |
| CSRF on mutating routes                                   | All mutations are bearer-auth (Authorization header, not cookies); cookies are only used for the WebSocket handshake. |
| SSRF / open redirect from webhook handlers                | Webhook handlers never make outbound HTTP based on attacker input; TwiML responses are templated.                     |
| Unauthorized number access                                | `findOwned` / `JwtAuthGuard`: every read/write asserts ownership before returning data.                               |
| Replay of an outbound webhook (e.g. duplicate SMS status) | Idempotency keyed on `MessageSid` / `CallSid`.                                                                        |
| Secrets in logs                                           | `RequestIdMiddleware` and `HttpLoggerMiddleware` log only structural metadata — never headers, bodies, query secrets. |

## What we do **not** defend against

- A compromised owner workstation. The bearer token, voice token, and
  microphone are inevitably accessible to anything running on the operator's
  machine. The mitigation is operator hygiene (lock screen, OS updates).
- A compromised Twilio account. If an attacker obtains the live Twilio
  Account SID + Auth Token they can buy numbers, send SMS, and place calls
  outside this app. Mitigation: rotate creds, use restricted API keys, and
  treat the audit log + Twilio's own debugger as detection signals.
- A compromised database or hosting provider. The DB stores hashed passwords
  and audit data — but it also stores the operator's call/SMS history. We
  rely on the provider's at-rest encryption and TLS in transit.

## Secrets

| Secret                                   | Where it lives                                                 |
| ---------------------------------------- | -------------------------------------------------------------- |
| `TWILIO_ACCOUNT_SID` / `_AUTH_TOKEN`     | API env only.                                                  |
| `TWILIO_API_KEY_SID` / `_API_KEY_SECRET` | API env only. Used to mint Voice Access Tokens.                |
| `TWILIO_TWIML_APP_SID`                   | API env only.                                                  |
| `JWT_SECRET` / `SESSION_SECRET`          | API env only. ≥ 32 bytes of entropy each.                      |
| `BOOTSTRAP_TOKEN`                        | API env only. Single-use to create the owner; remove after.    |
| `DATABASE_URL` / `DIRECT_DATABASE_URL`   | API env only. Use TLS-only connection strings.                 |
| `REDIS_URL`                              | API env only. Use TLS.                                         |
| `OWNER_INITIAL_PASSWORD`                 | Local one-time use only. Rotate immediately after first login. |

The frontend bundle ships with **only**:

- `VITE_API_BASE_URL` — your public API origin.
- `VITE_WS_URL` — your public WebSocket origin.
- `VITE_APP_NAME` — display string.

The bundle has been audited (Phase 9) to ensure no Twilio credential names
appear in the build.

## Twilio webhook signature validation

Twilio signs every webhook with HMAC-SHA1 over `URL + concat(sorted(key+value))`
using the Auth Token, base64-encoded. Our guard:

1. Reads `X-Twilio-Signature` from the request.
2. Reconstructs the canonical URL: `TWILIO_WEBHOOK_BASE_URL + req.originalUrl`.
3. Calls `validateRequest` (the official `twilio` SDK helper) with the parsed
   form body. **Returns false** on any error or absence of signature.
4. Returning `false` from a guard turns into a 403 — the controller never
   runs.

`TwilioSignatureGuard` is end-to-end tested in
`apps/api/src/webhooks/twilio-signature.roundtrip.test.ts`, which signs payloads
with the same algorithm Twilio uses and verifies all four primary outcomes
(valid / invalid sig / missing sig / wrong URL / tampered body / wrong token).

## Voice Access Tokens

The browser receives a Voice Access Token from `POST /api/voice/token`. The
token:

- Is a **separate JWT** signed with the Twilio API Key Secret — _not_ the
  owner JWT.
- Has a 1-hour TTL by default, set on the server side.
- Is scoped to a single per-number identity
  (`user_<userId>_number_<numberId>`) so even if it leaks, it can only place
  calls _as that identity_, into our TwiML App, and it will be rejected if
  the user no longer owns that number.
- Is rotated on demand from the client side when the SDK reports
  `tokenWillExpire` (Phase 8 hook).

## Audit log

`AuditLog` rows are append-only and store `{ userId, action, entityType,
entityId, ipAddress, userAgent, metadata, createdAt }`. We log:

- Login (success + failure), password change, logout.
- Number lifecycle: search, purchase, update, sync, webhook reconfigure,
  release, deactivate.
- SMS: send (success + failure), retry.
- Calls: outbound prepare, hangup.
- Webhook ingestion: each inbound message/call write also produces a record.

Mutations should always go through a service method that calls
`AuditService.log` — there are unit tests in each `*.service.test.ts` that
assert the audit row is created.

## Operator hygiene checklist

- [ ] Use a dedicated Twilio sub-account or restricted API key.
- [ ] Set `BOOTSTRAP_TOKEN` once, run `/auth/bootstrap-owner` once, then
      _delete the env var_ and redeploy.
- [ ] Rotate `JWT_SECRET` every 90 days; the next login will mint a new JWT.
- [ ] Keep `OWNER_INITIAL_PASSWORD` only long enough to log in for the first
      time; change it immediately and delete the env var.
- [ ] Verify `TWILIO_WEBHOOK_BASE_URL` is HTTPS in production. The settings
      page surfaces a warning if it isn't.
- [ ] Periodically run `pnpm tsx scripts/twilio-sync.ts verify` to detect
      drift between Twilio and the DB.
