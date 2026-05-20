# Manual Twilio production checklist

Run end-to-end after every deploy that changes anything in the
authentication, webhook, voice, or SMS path. Print this page, tick each
box, archive with the deploy in your incident folder.

| #   | Step                                                          | Expected outcome                                                                | ✅  |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- | --- |
| 1   | `curl https://api.webfitalchemist.online/api/health`          | `{ status: "ok" }`                                                              |     |
| 2   | `curl https://api.webfitalchemist.online/api/health/db`       | `{ status: "ok" }`                                                              |     |
| 3   | `curl https://api.webfitalchemist.online/api/health/redis`    | `{ status: "ok" }`                                                              |     |
| 4   | `curl https://api.webfitalchemist.online/api/health/twilio`   | `{ status: "ok" }`                                                              |     |
| 5   | Browse to `https://app.webfitalchemist.online`                | Login page loads with valid TLS.                                                |     |
| 6   | Sign in as the owner                                          | Redirected to `/dashboard`; account email + role visible.                       |     |
| 7   | `/settings/diagnostics`                                       | All four checks `ok`; webhook base URL is HTTPS.                                |     |
| 8   | Buy a test number via `/numbers/new` (Local, +1, voice + SMS) | Number appears in `/numbers`; Twilio Console shows configured webhook URLs.     |     |
| 9   | `pnpm tsx scripts/twilio-sync.ts verify` (locally)            | Exits 0, no mismatches.                                                         |     |
| 10  | From your phone, **send an SMS** to the test number           | Message appears in `/numbers/:id/messages` within ~3s, no refresh.              |     |
| 11  | From the inbox, **send an SMS** to your phone                 | `QUEUED` → `SENT` → `DELIVERED` updates; phone receives within ~10s.            |     |
| 12  | From your phone, **call** the test number                     | `/numbers/:id/answer` rings; _Answer_ connects two-way audio.                   |     |
| 13  | Hang up the call                                              | `/numbers/:id/calls` shows the call with correct duration and status.           |     |
| 14  | `/numbers/:id/dial` → dial your phone                         | Phone shows the Twilio number as caller ID; two-way audio works.                |     |
| 15  | Open Twilio Console → _Monitor → Debugger_                    | Empty (no 4xx, 5xx, or signature-mismatch entries).                             |     |
| 16  | `/api/audit-logs?limit=10` (or diagnostics page)              | Every action above appears (`number.purchased`, `sms.sent`, `call.hangup`, …).  |     |
| 17  | Refresh `/settings/diagnostics`                               | `Webhook ingest → Total` increased; `Last event` is recent.                     |     |
| 18  | Sign out                                                      | Redirect to `/login`; bearer token cleared from `localStorage`.                 |     |
| 19  | Try a protected route while signed out, e.g. `/numbers`       | Redirect to `/login` with the original URL preserved.                           |     |
| 20  | (Optional) Release the test number from `/numbers/:id`        | Twilio Console no longer shows the number; audit log records `number.released`. |     |

If any step fails, **do not mark the release green**. See
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) for the symptom → fix mapping.
