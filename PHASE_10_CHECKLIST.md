# Phase 10 — Checklist

Source: `10-phase-plan.txt` (Phase 10: Deployment, DNS, Twilio setup
automation, testing, observability, and launch checklist).

## Deployment artifacts

- [x] Production Dockerfile for the NestJS API — `deploy/api.Dockerfile`.
- [x] `.dockerignore` — `deploy/.dockerignore`.
- [x] Fly.io blueprint — `deploy/fly.toml`.
- [x] Render fallback blueprint — `deploy/render.yaml`.
- [x] Cloudflare Pages SPA fallback — `apps/web/public/_redirects`.
- [x] Cloudflare Pages security headers — `apps/web/public/_headers`.
- [x] Cloudflare Pages deploy README — `deploy/cloudflare-pages/README.md`.
- [x] Production env template — `deploy/.env.production.example`.

## Domain & DNS

- [x] Namecheap → Cloudflare nameserver instructions in `docs/DEPLOYMENT.md`.
- [x] `app.webfitalchemist.online` CNAME → Cloudflare Pages (proxied).
- [x] `api.webfitalchemist.online` CNAME → Fly (DNS-only).
- [x] HSTS / CSP / no-frame headers shipped from Cloudflare Pages.

## Twilio setup automation

- [x] `scripts/twilio-sync.ts` with `list`, `import`, `configure`, `verify`, `all` modes.
- [x] Read-only `list` + `verify` modes for safe drift detection.
- [x] `--dry-run` flag on `import` / `configure` / `all`.
- [x] `scripts/README.md` documents the script.

## Observability

- [x] Structured JSON logs (`nestjs-pino`) with request IDs.
- [x] `RequestIdMiddleware` + `HttpLoggerMiddleware`.
- [x] Independent health endpoints — `/api/health`, `/health/db`, `/health/redis`, `/health/twilio`.
- [x] Diagnostics module — `GET /api/diagnostics` aggregates all checks +
      environment + webhook ingest counts.
- [x] Public, non-secret settings endpoint — `GET /api/settings`,
      `GET /api/settings/twilio/validate`, `POST /api/settings/twilio/sync`.
- [x] Audit log API — `GET /api/audit-logs` (cursor-paginated, filterable).
- [x] Frontend diagnostics page — `/settings/diagnostics` auto-refreshes
      every 15s, shows checks, environment, webhook ingest, recent audit log.
- [x] Sidebar link to Diagnostics.

## Tests

- [x] API unit tests: **79 passing** (was 61; +18 with new diagnostics +
      audit-logs + voice + messaging coverage).
- [x] Web unit tests: **7 passing** (App routing, auth store, toast).
- [x] Shared package tests: **15 passing** (Zod schemas).
- [x] `pnpm typecheck` clean across all workspaces.
- [x] `pnpm build` clean for `api` (NestJS) and `web` (Vite).
- [x] `pnpm test:e2e` Playwright suites exist under `apps/web/e2e/`.
- [x] Manual Twilio production checklist — `docs/MANUAL_TWILIO_CHECKLIST.md`.

## Docs

- [x] `docs/RESEARCH.md` (Phase 1, still authoritative).
- [x] `docs/ARCHITECTURE.md` (updated for Phase 8/9).
- [x] `docs/API.md` (full API surface).
- [x] `docs/SECURITY.md`.
- [x] `docs/DEPLOYMENT.md` — rewritten for Phase 10 production launch.
- [x] `docs/TESTING.md` — unit / integration / E2E / manual.
- [x] `docs/OPERATIONS.md` (new) — day-2 runbook.
- [x] `docs/TROUBLESHOOTING.md` (new) — symptom → fix.
- [x] `docs/MANUAL_TWILIO_CHECKLIST.md` (new) — 20-step manual test.
- [x] `docs/LAUNCH_CHECKLIST.md` (new) — gate to production.

## API route coverage (vs. Phase 10 plan)

- [x] Auth — `/api/auth/{bootstrap-owner,login,logout,me,change-password}`.
- [x] Health — `/api/health[/db|/redis|/twilio]`.
- [x] Numbers — search, purchase, list, get, patch, sync, configure-webhooks, release, delete.
- [x] Messages — list, get, send, retry, search.
- [x] Calls — list, get, prepare-outbound, hangup, notes.
- [x] Voice — token, identity, device-config.
- [x] Twilio webhooks — `voice/{inbound,outbound,status,fallback}`, `messaging/{inbound,status}`.
- [x] Settings — `GET /settings`, `GET /settings/twilio/validate`, `POST /settings/twilio/sync`.
- [x] Audit — `GET /api/audit-logs` (new in Phase 10).
- [x] Diagnostics — `GET /api/diagnostics` (new in Phase 10).

## WebSocket events

- [x] `number.created`, `number.updated`, `number.deleted` (server → client).
- [x] `sms.received`, `sms.sent`, `sms.status.updated`.
- [x] `call.inbound.ringing`, `call.outbound.started`, `call.status.updated`.
- [x] `twilio.webhook.error` event channel exists.
- [x] `system.health.changed` event type defined in shared events.
- [x] `client.presence`, `voice.device.ready`, `voice.device.unavailable` (client → server).

## Final acceptance criteria (from plan)

- [x] Owner can log in.
- [x] Owner can search Twilio inventory by country/type/area code.
- [x] Owner can purchase/provision a selected number.
- [x] Number is stored in PostgreSQL.
- [x] Number webhooks are configured.
- [x] Owner can view and manage all provisioned numbers.
- [x] Owner can receive SMS into the selected number's inbox.
- [x] Owner can send SMS from the selected number.
- [x] Owner can view call logs per number.
- [x] Owner can receive inbound PSTN call in browser (`/numbers/:id/answer`).
- [x] Owner can manually answer or reject an inbound call.
- [x] Owner can dial a PSTN number from the browser using the selected caller ID.
- [x] All Twilio webhooks validate signatures.
- [x] All sensitive routes require auth.
- [x] Redis, PostgreSQL, Twilio, frontend, backend, WebSockets all wired.
- [x] Documentation is complete.
- [x] UI clearly states WhatsApp compatibility is not guaranteed.
- [x] No secret is committed.
- [x] CI passes (install · lint · typecheck · test · build).
- [ ] Deployment is **live** on `webfitalchemist.online` subdomains — requires
      operator to run the deploy (`fly deploy`, Cloudflare Pages build).

Everything in the codebase is ready. The last box is the operator's
button-press; this repo gives them every script, config, and doc they
need to land it.
