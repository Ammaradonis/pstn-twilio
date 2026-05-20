# Troubleshooting

Symptom → diagnosis → fix. For ambient runbook detail see
[`OPERATIONS.md`](OPERATIONS.md).

## Voice

### Inbound PSTN call does not ring the browser

1. **Check the number is active and owned**
   ```sql
   SELECT id, phone_number_e164, active, user_id
   FROM phone_numbers
   WHERE phone_number_e164 = '+1...';
   ```
   `active=false` or `user_id=null` → the inbound webhook hangs up the call
   on purpose. Reactivate via the UI (`/numbers/:id` → reactivate) or set
   `user_id`.
2. **Check the webhook reached us**
   ```sql
   SELECT created_at, event_type, signature_valid, twilio_sid
   FROM webhook_events
   WHERE event_type = 'voice.inbound'
   ORDER BY created_at DESC
   LIMIT 5;
   ```

   - No row → Twilio never called us. Check the number's voice webhook URL
     in the Twilio Console; rerun `pnpm tsx scripts/twilio-sync.ts configure`.
   - `signature_valid=false` → the `TWILIO_WEBHOOK_BASE_URL` env var does
     not match the actual public URL. Update and redeploy.
3. **Check the browser is registered**: open `/numbers/:id/answer` and look
   at the readiness pills. If `registered=false`, the Twilio Device never
   came online — the user likely denied microphone permission or the Voice
   token expired.
4. **Check Twilio's view**: Twilio Console → _Monitor → Debugger_ will show
   the response we returned. If we returned `<Hangup/>` TwiML, line up the
   reason in the API logs (`req_id` in the response headers).

### Outbound call drops immediately

- The TwiML App's Voice URL is wrong. It must be
  `https://api.webfitalchemist.online/webhooks/twilio/voice/outbound`.
  Update in Twilio Console → _Voice → TwiML Apps → <app>_.
- Or the `client:` identity does not match the selected number.
  `VoiceWebhookService.handleOutbound` enforces ownership and will return
  `<Hangup/>` if the caller is not authorized. Check
  `audit_logs` for a `voice.token_issued` record; the identity there must
  match the identity Twilio sent.

## SMS

### Inbound SMS not appearing in the inbox

- `webhook_events` lacks a recent `messaging.inbound` row → Twilio didn't
  hit us. Verify webhook URL in the Twilio Console, rerun the sync script.
- Row present, `signature_valid=false` → `TWILIO_WEBHOOK_BASE_URL`
  mismatch.
- Row present, valid signature, but no `sms_messages` row → look at the
  API logs around the `created_at` time. The most common cause is the
  `To` value not matching any `phone_numbers.phone_number_e164` (e.g. a
  released number).
- The WebSocket event fired but the UI did not update → the browser tab
  is on a different number's inbox, or `socket.io` reconnected and missed
  the broadcast. Refreshing the page rehydrates from the DB.

### Outbound SMS stuck in `QUEUED` / `SENT` indefinitely

- Twilio status callbacks deliver `delivered`/`undelivered` async. If a
  message stays in `SENT` for > 5 minutes, the status callback URL is
  misconfigured; fix it with `scripts/twilio-sync.ts configure`.
- Check the Twilio Console's _Messaging → Logs_ — Twilio shows the carrier
  response code (`30007` = filtered, `30008` = unknown).

## Auth & sessions

### "Missing auth token" on `/socket.io`

The bearer JWT was not attached. Check `apps/web/src/lib/realtime.ts` is
reading `useAuthStore.getState().token` and passing it via
`io({ auth: { token } })`. Reload the page after sign-in.

### Bootstrap endpoint returns 403

`BOOTSTRAP_TOKEN` is unset (correct, after first use) — the endpoint is
intentionally one-shot. To create a new owner, restore the env var,
re-bootstrap, then unset again.

## Database

### `PrismaClientInitializationError` on boot

The pooled `DATABASE_URL` is unreachable. Confirm:

- Neon project is not suspended (free tier auto-suspends).
- `?sslmode=require&channel_binding=require` is on the connection string.
- The Fly machine region can reach Neon (Neon's AWS region must allow
  egress; this is rarely a problem).

### Migrations fail on deploy

`prisma migrate deploy` is idempotent — re-running is safe. If a failure
persists:

- Use `DIRECT_DATABASE_URL` for migrations, not the pooled URL.
- The migration file in `apps/api/prisma/migrations/` may need a manual
  `--create-only` step if it includes an unsupported operation.

## Redis

### `ECONNREFUSED` on Redis ping

- `REDIS_URL` is missing or wrong (must start with `rediss://` for TLS).
- Upstash database is paused (free tier).
- The Fly machine and Upstash region are too far apart — Redis ping is a
  good latency signal in `/api/diagnostics`.

## Webhook signature mismatches

A non-zero rate of `signature_valid=false` rows means one of:

1. `TWILIO_WEBHOOK_BASE_URL` ≠ the URL Twilio is actually calling. The
   guard reconstructs the canonical URL from
   `TWILIO_WEBHOOK_BASE_URL + req.originalUrl` and validates against
   the Auth Token; any prefix mismatch (e.g. http vs https, trailing
   slash, custom port) breaks the HMAC.
2. The wrong Twilio sub-account is signing the webhook. Each Twilio
   sub-account has its own Auth Token; ensure `TWILIO_AUTH_TOKEN`
   matches the account that owns the number.
3. Someone is actively replaying webhooks. The guard rejects them with
   403; the only damage is the row in `webhook_events`. Use it as an
   alert signal.

## CI / build

### `pnpm typecheck` works locally but fails in CI

CI installs from `pnpm-lock.yaml` with `--frozen-lockfile`. If you added
a dependency without committing the lockfile, CI will reject it. Always
commit the lockfile alongside `package.json` changes.

### `prisma generate` fails

The `prisma` directory must exist relative to `apps/api/`. The Dockerfile
copies it explicitly because `pnpm deploy --prod` does not include
non-package files by default.
