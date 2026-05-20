# Operations

Day-2 runbook for `pstn-twilio`. For first-time provisioning see
[`DEPLOYMENT.md`](DEPLOYMENT.md). For incidents see
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## Routine ops

| Task                         | Command / location                                                                | Cadence                              |
| ---------------------------- | --------------------------------------------------------------------------------- | ------------------------------------ |
| Live health probe            | `curl https://api.webfitalchemist.online/api/health` and `/db` `/redis` `/twilio` | continuous (uptime checker)          |
| Diagnostics overview         | `/settings/diagnostics` in the UI (owner-only)                                    | on every release / weekly            |
| Verify Twilio ↔ DB drift     | `pnpm tsx scripts/twilio-sync.ts verify`                                          | weekly                               |
| Reconfigure all webhooks     | `pnpm tsx scripts/twilio-sync.ts configure`                                       | after every `PUBLIC_BASE_URL` change |
| JWT key rotation             | rotate `JWT_SECRET` Fly secret → redeploy → users re-login                        | every 90 days                        |
| Twilio API key rotation      | new Standard API key → set `TWILIO_API_KEY_SID/SECRET` → redeploy → revoke old    | every 180 days                       |
| Database backup verification | restore Neon point-in-time snapshot into a scratch project                        | quarterly                            |
| Audit log review             | `GET /api/audit-logs?limit=200` or `/settings/diagnostics`                        | weekly                               |

## Observability surface

| Source                                | What it tells you                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------- | --------- | ----------------------------------------- |
| `GET /api/health[/db                  | /redis                                                                                    | /twilio]` | Independent liveness for each dependency. |
| `GET /api/diagnostics`                | Single owner-only report: env, all checks, webhook ingest summary.                        |
| `webhook_events` table                | Every Twilio webhook ever received, including invalid signatures (signature_valid=false). |
| `audit_logs` table                    | Every owner mutation: login, number lifecycle, SMS send/retry, calls hangup/note.         |
| Fly / Render logs                     | NestJS pino structured logs with `req_id`, method, path, status, duration.                |
| Twilio Console → _Monitor → Debugger_ | Twilio's own view of webhook failures, 4xx, 5xx, signature mismatches.                    |

## Routine queries

```sql
-- Most recent webhook failures (invalid signature, wrong URL, etc.)
SELECT created_at, event_type, twilio_sid
FROM webhook_events
WHERE signature_valid = false
ORDER BY created_at DESC
LIMIT 20;

-- SMS that failed delivery in the last 24h
SELECT id, twilio_message_sid, status, error_code, error_message, created_at
FROM sms_messages
WHERE status IN ('FAILED', 'UNDELIVERED')
  AND created_at >= NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;

-- Inbound calls that never reached the browser
SELECT id, twilio_call_sid, from_e164, to_e164, status, created_at
FROM calls
WHERE direction = 'INBOUND' AND status IN ('NO_ANSWER', 'CANCELED', 'FAILED')
  AND created_at >= NOW() - INTERVAL '7 days'
ORDER BY created_at DESC;
```

## Capacity & cost dials

- **Fly machines:** start at the smallest shared-cpu-1x; the API is
  predominantly I/O bound (Postgres, Twilio, Redis). Bump to
  `shared-cpu-2x` if `/api/diagnostics` durations climb past ~150ms.
- **Postgres pool:** Neon's pooled URL multiplexes connections — keep
  `DATABASE_URL` pinned to the pooler endpoint and reserve the direct
  URL for migrations only.
- **Twilio:** voice and SMS pricing is per-call/per-message; check the
  Twilio Console for live spend. The app never bursts traffic on its
  own — every outbound action is owner-initiated.

## Adding a new owner-side feature

1. Add the Prisma model fields if the feature needs state.
2. Generate a migration with `pnpm prisma:migrate`.
3. Add the service + controller in `apps/api/src/<feature>/`.
4. Add the matching DTO/schema to `packages/shared/src/`.
5. Wire the API call into `apps/web/src/lib/api-client.ts`.
6. Add the page under `apps/web/src/pages/` and route it in `app.tsx`.
7. Write tests for the service and DTO mappers.
8. Update [`API.md`](API.md).

## On-call playbook

See [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) for the actual symptom → fix
playbook. Highest-priority alerts:

1. `GET /api/health/twilio` fails — Twilio credential expiry; inbound
   calls and SMS will start failing within minutes.
2. `webhook_events.signature_valid = false` rate > 0 over 5 min — someone
   is spoofing webhooks, or our `TWILIO_WEBHOOK_BASE_URL` is wrong.
3. WebSocket disconnects on `/socket.io` exceed a few per minute — the
   browser softphone will not ring on inbound PSTN calls.
