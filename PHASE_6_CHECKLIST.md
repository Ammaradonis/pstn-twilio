# Phase 6 — Post-Implementation Checklist

## What ships in this phase

### Backend

- [x] `TwilioModule` / `TwilioService` (global) — wraps the Twilio Node SDK, exposes `client`, webhook helpers, and `validateSignature`.
- [x] `RedisModule` / `RedisService` at the root level so the existing Phase 3 health controller compiles and runs.
- [x] `NumbersModule` wiring the Twilio + Prisma + Audit modules.
- [x] `NumbersService` with: `listCountries`, `searchAvailable`, `purchase`, `list`, `getById`, `update`, `configureWebhooks`, `sync`, `release`, `deactivate`.
- [x] `NumbersController` mounting these endpoints behind `JwtAuthGuard` + `RolesGuard`. Mutations require `OWNER`/`ADMIN`.
- [x] Zod validation pipe at `src/common/zod.pipe.ts`, used with the existing schemas in `@pstn-twilio/shared`.
- [x] Unit tests for service authorization, conflict handling, purchase happy path, and mapper helpers.

### Frontend

- [x] `apps/web/src/lib/api-client.ts` extended with auth + numbers endpoints, bearer-token storage, and an `ApiError` class.
- [x] `/numbers/new` — country dropdown, search form (area code, region, locality, contains, capabilities), result list, and purchase confirmation modal.
- [x] `/numbers` — filterable management table with capability badges, webhook status, WhatsApp status, and per-row links (inbox / calls / answer / dial / settings).
- [x] `/numbers/:numberId` — metadata, capabilities, webhook URLs, rename, sync, reconfigure webhooks, deactivate, and a confirm-by-typing release modal.
- [x] Shared `WhatsAppDisclaimer` and `InventoryDisclaimer` components surfaced in the search and management UIs.

## API endpoints exposed in Phase 6

| Method | Path                                        | Notes                                                |
| ------ | ------------------------------------------- | ---------------------------------------------------- |
| GET    | `/api/phone-number-options/countries`       | Authenticated. Lists Twilio-supported countries.     |
| GET    | `/api/numbers/available`                    | Authenticated. Validated by `numberSearchSchema`.    |
| POST   | `/api/numbers/purchase`                     | OWNER/ADMIN. Validated by `purchaseNumberSchema`.    |
| GET    | `/api/numbers`                              | Authenticated. OWNER sees all; others see their own. |
| GET    | `/api/numbers/:numberId`                    | Authenticated + ownership.                           |
| PATCH  | `/api/numbers/:numberId`                    | Authenticated + ownership.                           |
| POST   | `/api/numbers/:numberId/configure-webhooks` | OWNER/ADMIN. Re-pushes app webhook URLs.             |
| POST   | `/api/numbers/:numberId/sync`               | Authenticated. Pulls fresh state from Twilio.        |
| POST   | `/api/numbers/:numberId/release`            | OWNER/ADMIN. Hard release on Twilio + audit log.     |
| POST   | `/api/numbers/:numberId/deactivate`         | OWNER/ADMIN. Local-only deactivation.                |
| DELETE | `/api/numbers/:numberId`                    | OWNER/ADMIN. Alias for deactivate.                   |

## Audit log actions emitted

- `number.purchased`
- `number.updated`
- `number.webhooks_configured`
- `number.synced`
- `number.released`
- `number.deactivated`

Each entry captures `userId`, `ipAddress`, `userAgent`, and metadata where useful (e.g., target `phoneNumber`, target SID, requested changes).

## Webhook URLs configured at purchase time

The backend reads `TWILIO_WEBHOOK_BASE_URL` (falling back to `PUBLIC_BASE_URL`) and configures these on every purchased number and during `configure-webhooks`:

- `POST {base}/webhooks/twilio/voice/inbound`
- `POST {base}/webhooks/twilio/voice/fallback`
- `POST {base}/webhooks/twilio/voice/status`
- `POST {base}/webhooks/twilio/messaging/inbound`
- `POST {base}/webhooks/twilio/messaging/inbound` (fallback)

The matching webhook receivers ship in Phase 7 (messaging) and Phase 8 (voice).

## Required environment variables

Already present in `.env.example`:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_DEFAULT_COUNTRY` (defaults to `US` if unset)
- `TWILIO_WEBHOOK_BASE_URL` or `PUBLIC_BASE_URL`

These must be **publicly reachable HTTPS URLs in production** so Twilio can deliver webhooks. For local development, use a tunneling tool (Cloudflared, ngrok) and set `TWILIO_WEBHOOK_BASE_URL` to the tunnel URL.

## Acceptance criteria — verified

- [x] User cannot purchase without an explicit modal confirmation (`PurchaseConfirmModal`).
- [x] User must enter an area code or region for narrowed searches; the UI exposes both.
- [x] Purchased numbers are immediately configured with app webhooks (single Twilio create call sets voice/SMS/status callbacks).
- [x] App can resync Twilio-side configuration via `POST /numbers/:id/sync`.
- [x] Release flow requires the user to type the full E.164 number to confirm and writes an audit log entry.

## Verification commands

```pwsh
# 1. Install and generate Prisma client (if you haven't since Phase 5)
pnpm install
pnpm --filter @pstn-twilio/api prisma:generate

# 2. Typecheck both apps
pnpm --filter @pstn-twilio/api typecheck
pnpm --filter @pstn-twilio/web typecheck

# 3. Run backend tests
pnpm --filter @pstn-twilio/api test

# 4. Start the API (needs valid TWILIO_* env vars to actually hit Twilio)
pnpm --filter @pstn-twilio/api dev

# 5. Start the web app
pnpm --filter @pstn-twilio/web dev
```

## Manual smoke test (with a real Twilio account)

1. Bootstrap an owner via `POST /api/auth/bootstrap-owner`.
2. Log in via `POST /api/auth/login`; copy the JWT.
3. `GET /api/phone-number-options/countries` returns Twilio's country catalog.
4. `GET /api/numbers/available?country=US&type=local&areaCode=415&voiceEnabled=true&smsEnabled=true` returns candidates.
5. `POST /api/numbers/purchase` with `{ "phoneNumber": "+1...", "friendlyName": "Test" }` provisions the number and configures webhooks.
6. `GET /api/numbers` shows the new number with `voiceWebhookUrl`, `smsWebhookUrl`, `statusCallbackUrl` populated.
7. `POST /api/numbers/:id/sync` round-trips through Twilio.
8. `POST /api/numbers/:id/release` removes the number from Twilio and marks `releasedAt`.
9. The `audit_logs` table contains one row per mutation, tied to the actor's user id.

## Known constraints

- `numberType` on `PhoneNumber` defaults to `UNKNOWN` after purchase because Twilio's IncomingPhoneNumber response does not include the inventory type. The user can refine this manually via PATCH if needed.
- `whatsappCompatibilityStatus` is set to `NOT_GUARANTEED` for every newly purchased number. The plan is explicit that we do not advertise WhatsApp compatibility; the UI always renders the disclaimer.
- The numbers controller currently uses a JWT bearer flow (matching Phase 5). Cookie sessions are out of scope here.
