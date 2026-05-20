# Production launch checklist

The one-time gate between "code complete" and "owner-can-use-it". Work
top-to-bottom; do not skip ahead.

## Code & repo

- [ ] `main` is green in GitHub Actions (`install · lint · typecheck · test · build`).
- [ ] No `.env`, `env.txt`, or other secret-bearing file is committed
      (run `git log -p -- env.txt .env` and confirm).
- [ ] `pnpm-lock.yaml` is up to date with every `package.json` change.
- [ ] All `PHASE_*_COMPLETE.md` documents exist for phases 1–9 plus this
      one, and the plan in `10-phase-plan.txt` is up to date.

## Database (Neon)

- [ ] Production database exists with both pooled + direct URLs.
- [ ] `prisma migrate deploy` runs cleanly on a fresh deploy.
- [ ] Point-in-time recovery is enabled for the project.
- [ ] Backups have been **manually restored** at least once into a scratch
      database to verify the restore path.

## Cache (Redis)

- [ ] Upstash (or equivalent) database created with TLS enforced.
- [ ] `REDIS_URL` starts with `rediss://`.
- [ ] `GET /api/health/redis` returns `{ status: "ok" }`.

## DNS (Cloudflare via Namecheap)

- [ ] Namecheap nameservers point at Cloudflare.
- [ ] `app.webfitalchemist.online` CNAME → Cloudflare Pages.
- [ ] `api.webfitalchemist.online` CNAME → Fly / Render (DNS-only).
- [ ] HTTPS works on both subdomains; no mixed-content warnings in the
      browser console.

## Backend (Fly / Render)

- [ ] Image built from `deploy/api.Dockerfile`; pushed to the registry.
- [ ] Secrets set per `deploy/.env.production.example`.
- [ ] `BOOTSTRAP_TOKEN` set just long enough to create the owner, then
      unset and the API redeployed.
- [ ] `JWT_SECRET` / `SESSION_SECRET` are ≥ 48 random bytes each.
- [ ] `/api/health` / `/db` / `/redis` / `/twilio` all return `ok`.
- [ ] CORS allowlist is exactly `https://app.webfitalchemist.online`.
- [ ] Helmet defaults are applied (smoke-test the response headers).
- [ ] WebSocket upgrade works (`wss://api.webfitalchemist.online/socket.io/?...`).

## Frontend (Cloudflare Pages)

- [ ] Production build env vars set (`VITE_API_BASE_URL`, `VITE_WS_URL`,
      `VITE_APP_NAME`).
- [ ] `_headers` and `_redirects` from `apps/web/public/` are present in
      the deployed bundle.
- [ ] `/login`, `/dashboard`, deep links all work after a hard refresh
      (SPA fallback).
- [ ] No Twilio secret name appears in the built bundle
      (`grep -r TWILIO apps/web/dist/` returns nothing meaningful).

## Twilio

- [ ] Restricted API Key (Standard, not Master) created and stored in
      `TWILIO_API_KEY_SID/SECRET`.
- [ ] TwiML App Voice URL points at the prod API.
- [ ] At least one number is provisioned with the five webhook URLs.
- [ ] `pnpm tsx scripts/twilio-sync.ts verify` exits 0 in production.
- [ ] Twilio Console → _Monitor → Debugger_ is empty after a synthetic
      round-trip (one inbound SMS + one inbound call + one outbound call + one outbound SMS).

## Owner bootstrap

- [ ] `/api/auth/bootstrap-owner` returned 201 once.
- [ ] `BOOTSTRAP_TOKEN` env var has been **unset** and the API
      redeployed.
- [ ] Owner password has been changed from the initial value via
      `/settings/security`.

## Manual Twilio test

- [ ] All 20 boxes in [`MANUAL_TWILIO_CHECKLIST.md`](MANUAL_TWILIO_CHECKLIST.md)
      are ticked.

## Observability & ops

- [ ] An external uptime probe (e.g. UptimeRobot) hits `/api/health`
      every minute.
- [ ] Fly / Render log retention is at least 7 days.
- [ ] Twilio Console alerts are configured for _Errors_ and _High Cost_.
- [ ] The audit log is reviewed for any unexpected entries from
      bootstrap activity.

## WhatsApp compliance disclaimer

- [ ] The "WhatsApp compatibility not guaranteed" banner is visible on
      `/numbers/new`, `/numbers`, and the layout sidebar.
- [ ] No copy on any page promises WhatsApp eligibility.

## Documentation

- [ ] `RESEARCH.md`, `ARCHITECTURE.md`, `API.md`, `SECURITY.md`,
      `DEPLOYMENT.md`, `TESTING.md`, `OPERATIONS.md`,
      `TROUBLESHOOTING.md`, this file, and
      `MANUAL_TWILIO_CHECKLIST.md` all exist and reflect the running
      build.
- [ ] `README.md` links to all of the above.

When every box is ticked, the owner can be handed the URL.
