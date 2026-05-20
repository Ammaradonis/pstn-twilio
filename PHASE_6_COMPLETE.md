# Phase 6 Implementation Complete

## Summary

Phase 6 (Twilio number search, purchase/provisioning, configuration, and management) is implemented end-to-end. The backend can list Twilio's country catalog, search inventory, purchase numbers (auto-configuring all required webhooks), and manage their lifecycle. The frontend exposes search/purchase, a numbers management table, and a number detail page with rename/sync/reconfigure/release actions. All mutations are JWT-protected, role-gated, and audit-logged.

## What was implemented

### Backend (`apps/api`)

- `src/twilio/twilio.module.ts`, `src/twilio/twilio.service.ts` — global module wrapping the Twilio Node SDK. Provides the lazy `client`, `accountSid`, `authToken`, `defaultCountry`, `webhookBaseUrl`, `defaultWebhookUrls()`, `validateSignature()`, and `validateCredentials()`.
- `src/redis/redis.module.ts`, `src/redis/redis.service.ts` — root-level Redis client matching the existing health controller's import path. Closes a pre-existing build gap so the API now typechecks and runs.
- `src/common/zod.pipe.ts` — generic `ZodValidationPipe<T>` used by the numbers endpoints with the existing schemas in `@pstn-twilio/shared`.
- `src/numbers/`
  - `numbers.module.ts`
  - `numbers.service.ts` — search/purchase/list/get/update/configure-webhooks/sync/release/deactivate, all writing audit logs.
  - `numbers.controller.ts` — REST routes guarded by `JwtAuthGuard` + `RolesGuard`; mutations require `OWNER`/`ADMIN`.
  - `numbers.mapper.ts` — Twilio → DTO normalization (capability casing, address requirements, area code inference).
  - `numbers.service.test.ts` — service-level unit tests with mocked Prisma/Twilio/Audit.
- `src/app.module.ts` wired `TwilioModule`, `RedisModule`, `NumbersModule`.

### Frontend (`apps/web`)

- `src/lib/api-client.ts` — rewritten as a typed client with bearer-token storage (`getToken`/`setToken`), an `ApiError` class, and methods for auth + numbers.
- `src/lib/format.ts` — `formatPhone`, `formatDate`, `capabilityBadge` helpers.
- `src/components/disclaimer.tsx` — `WhatsAppDisclaimer`, `InventoryDisclaimer`.
- `src/pages/number-new.tsx` — country selector, type selector, NANP area code field, locality/region/postal-code filters, capability checkboxes, results table, purchase confirmation modal.
- `src/pages/numbers.tsx` — filterable management table with capability badges, webhook configuration status, WhatsApp compatibility label, active/inactive pill, and per-row links to inbox/calls/answer/dial/settings.
- `src/pages/number-detail.tsx` — metadata + capabilities cards, webhook URLs panel with sync/reconfigure buttons, lifecycle panel with deactivate and "type-the-number-to-confirm" release modal.

## API surface

| Method | Path                                        |
| ------ | ------------------------------------------- |
| GET    | `/api/phone-number-options/countries`       |
| GET    | `/api/numbers/available`                    |
| POST   | `/api/numbers/purchase`                     |
| GET    | `/api/numbers`                              |
| GET    | `/api/numbers/:numberId`                    |
| PATCH  | `/api/numbers/:numberId`                    |
| POST   | `/api/numbers/:numberId/configure-webhooks` |
| POST   | `/api/numbers/:numberId/sync`               |
| POST   | `/api/numbers/:numberId/release`            |
| POST   | `/api/numbers/:numberId/deactivate`         |
| DELETE | `/api/numbers/:numberId`                    |

## Security and compliance

- All endpoints require a valid JWT (`JwtAuthGuard` from Phase 5).
- Purchase/release/configure/deactivate require `OWNER` or `ADMIN` (`RolesGuard`).
- Ownership is enforced inside the service: non-OWNER users may only see/touch numbers where `phone_numbers.user_id` matches their id.
- Every mutation writes an `audit_logs` row capturing `userId`, `ipAddress`, `userAgent`, and entity metadata.
- The UI surfaces the inventory disclaimer ("This searches Twilio inventory. It does not create arbitrary PSTN numbers, spoof caller ID, or bypass carriers.") and the WhatsApp disclaimer on every search and detail view.
- Newly purchased numbers default to `whatsappCompatibilityStatus = NOT_GUARANTEED`. The system never claims WhatsApp eligibility implicitly.

## Tests

- `pnpm --filter @pstn-twilio/api typecheck` — clean.
- `pnpm --filter @pstn-twilio/web typecheck` — clean.
- `pnpm --filter @pstn-twilio/api test` — 8 tests passing across `numbers.service.test.ts` and `app.e2e.test.ts`. New coverage:
  - `findOwned` returns `NotFoundException` for missing IDs.
  - `findOwned` returns `ForbiddenException` for non-owner cross-tenant access.
  - `purchase` rejects already-provisioned numbers with `ConflictException`.
  - `purchase` happy path calls Twilio with the correct webhook URLs and writes an audit log.
  - Mapper helpers (`inferAreaCode`, `inferNumberType`, `mapAvailableNumber`) normalize Twilio's mixed casing.

## Acceptance criteria (from `10-phase-plan.txt`)

- [x] User cannot purchase without explicit confirmation — modal requires a deliberate click; release modal additionally requires typing the full E.164 number.
- [x] User must choose area code/region where supported — UI exposes both fields; NANP local searches strongly nudge toward area code.
- [x] Purchased numbers are immediately configured with app webhooks — single `incomingPhoneNumbers.create` call sets voice/SMS/status callbacks; the local DB stores the configured URLs.
- [x] App can resync Twilio-side configuration — `POST /numbers/:id/sync` pulls Twilio's current view and updates the DB.
- [x] Release flow is protected by confirmation and audit log — type-to-confirm modal + `number.released` audit entry with the original E.164 in metadata.

## What's next (Phase 7)

- `POST /webhooks/twilio/messaging/inbound` and `POST /webhooks/twilio/messaging/status` handlers (signature validation, dedupe, persist `sms_messages`, broadcast `sms.received` / `sms.status.updated`).
- Outbound `POST /api/numbers/:numberId/messages` with rate limiting and lawful-consent UI copy.
- `/numbers/:numberId/messages` page using the existing TanStack Query + WebSocket scaffolding.

Phase 6 status: complete.
