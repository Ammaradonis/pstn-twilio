# Deployment

This document is the canonical production runbook for `pstn-twilio`. It covers
the full Phase-10 launch: Cloudflare DNS, Cloudflare Pages for the frontend,
Fly.io (or Render) for the NestJS backend, Neon Postgres, Upstash Redis, and
the Twilio webhook / TwiML App wiring.

Production hostnames (Namecheap domain → Cloudflare):

| Hostname                 | Role                                                    |
| ------------------------ | ------------------------------------------------------- |
| `bestsoftphone.site`     | Cloudflare Pages — React SPA.                           |
| `app.bestsoftphone.site` | Cloudflare Pages — same React SPA as the apex.          |
| `api.bestsoftphone.site` | Fly.io / Render — NestJS + Socket.IO + Twilio webhooks. |

## 1. Prerequisites

| Provider         | What you need                                                                                       |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| Namecheap        | Owner of `bestsoftphone.site`.                                                                      |
| Cloudflare       | Account, API token with zone creation, DNS edit, and Pages edit permissions; a zone for the domain. |
| Neon             | Project + a database, both pooled and direct connection strings.                                    |
| Redis            | Upstash (recommended) with TLS, or any TLS-capable provider.                                        |
| Twilio           | Account SID, Auth Token, API Key SID + Secret, TwiML App SID, at least one purchased number.        |
| Fly.io or Render | Account with billing enabled and `fly` / `render` CLI installed.                                    |

Each provider's secrets belong in [`deploy/.env.production.example`](../deploy/.env.production.example).
Never commit real values — both `.env` and `env.txt` are gitignored.

## 2. Cloudflare DNS (Namecheap → Cloudflare)

1. **Cloudflare:** add `bestsoftphone.site` to your account and note the
   two Cloudflare nameservers.
2. **Namecheap:** _Domain List → Manage → Nameservers → Custom DNS_ — paste
   both Cloudflare nameservers. Propagation is usually minutes.
3. **Cloudflare → DNS → Records:**

   | Type  | Name  | Content                     | Proxy                      |
   | ----- | ----- | --------------------------- | -------------------------- |
   | CNAME | `@`   | `pstn-twilio-web.pages.dev` | Proxied                    |
   | CNAME | `app` | `pstn-twilio-web.pages.dev` | Proxied                    |
   | A     | `api` | `66.241.125.37`             | DNS only (Fly handles TLS) |
   | AAAA  | `api` | `2a09:8280:1::118:4965:0`   | DNS only (Fly handles TLS) |
   - Keep `api` DNS-only so Fly terminates TLS directly and Twilio webhook
     signature validation sees the canonical `api.bestsoftphone.site` URL.

4. **Cloudflare → SSL/TLS → Edge Certificates:** enable _Always Use HTTPS_,
   _HSTS_ with `max-age=63072000; includeSubDomains; preload`, and _Automatic
   HTTPS Rewrites_. The SPA's `_headers` file echoes these for defence in
   depth.

## 3. Database (Neon)

1. Create a Neon project in the same region as the API (e.g. `aws-us-east-1`).
2. Get the **pooled** and **direct** connection strings — both with
   `sslmode=require&channel_binding=require`.
3. Set both in production secrets:
   - `DATABASE_URL` → pooled
   - `DIRECT_DATABASE_URL` → direct (used by `prisma migrate deploy`)
4. The image runs `prisma migrate deploy` on every boot. Use Neon's
   point-in-time-restore for backups; no extra config is needed.

## 4. Redis (Upstash)

1. Create an Upstash Redis database with TLS.
2. Copy the connection string (`rediss://default:...@host:port`) into
   `REDIS_URL`.
3. The API uses Redis for ephemeral state (rate-limit windows, Voice
   token-issuance dedupe, gateway pub/sub) — sized in MB, not GB.

## 5. Backend (Fly.io recommended; Render as backup)

Fly is recommended because it speaks native WebSockets, runs a long-lived
Node process, and lets us pin a region close to Twilio's signaling layer
(`iad`).

### Fly.io

```bash
# One-time
fly launch --no-deploy --copy-config --dockerfile deploy/api.Dockerfile

# Secrets (paste real values; do not commit)
fly secrets set \
  NODE_ENV=production \
  PORT=3000 \
  PUBLIC_BASE_URL=https://api.bestsoftphone.site \
  WEB_APP_URL=https://app.bestsoftphone.site \
  CORS_ORIGINS=https://bestsoftphone.site,https://app.bestsoftphone.site \
  TWILIO_WEBHOOK_BASE_URL=https://api.bestsoftphone.site \
  DATABASE_URL=... \
  DIRECT_DATABASE_URL=... \
  REDIS_URL=... \
  JWT_SECRET=... \
  SESSION_SECRET=... \
  TWILIO_ACCOUNT_SID=... \
  TWILIO_AUTH_TOKEN=... \
  TWILIO_API_KEY_SID=... \
  TWILIO_API_KEY_SECRET=... \
  TWILIO_TWIML_APP_SID=... \
  TWILIO_DEFAULT_COUNTRY=US

# Custom domain + TLS cert
fly certs create api.bestsoftphone.site

# Deploy
fly deploy --remote-only --config deploy/fly.toml --dockerfile deploy/api.Dockerfile
```

Check the release: `fly status`, `fly logs`, then
`curl https://api.bestsoftphone.site/api/health`.

**Automatic deploys.** The `deploy-api` job in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs the deploy
command above on every push to `main` that touches files the API image is built
from (`apps/api`, `packages/shared`, lockfile, patches, Dockerfile, …), and
only after lint, typecheck, test and build pass. Web-only pushes skip it, so the
API isn't restarted mid-call for nothing. To redeploy by hand, use **Run
workflow** on the CI workflow in the Actions tab. It authenticates with the
`FLY_API_TOKEN` repo secret, an app-scoped deploy token
(`fly tokens create deploy -a pstn-twilio-api`).

### Render (alternative)

Apply [`deploy/render.yaml`](../deploy/render.yaml) via Render's blueprint
flow and paste secrets in the dashboard. The Docker image and runtime
commands are identical to the Fly path.

## 6. Frontend (Cloudflare Pages)

Build settings are documented in
[`deploy/cloudflare-pages/README.md`](../deploy/cloudflare-pages/README.md).
The short version:

```
Build command:   pnpm -F @pstn-twilio/shared build && pnpm -F @pstn-twilio/web build
Build output:    apps/web/dist
Root directory:  /
```

Production env (Cloudflare Pages → Settings → Environment variables → Production):

```
VITE_API_BASE_URL = https://api.bestsoftphone.site/api
VITE_WS_URL       = wss://api.bestsoftphone.site
VITE_APP_NAME     = pstn-twilio
VITE_REPEAT_DIAL_WARNING_ENABLED = false
```

During the DNS transition, the live Pages build and Fly webhook callbacks use
their provider hostnames (`pstn-twilio-web.pages.dev` and
`pstn-twilio-api.fly.dev`). Once the custom DNS records resolve and Fly reports
the API certificate as verified, switch the Pages variables and Fly public URL
secrets to the custom hostnames shown above, then run the Twilio sync `configure`
and `verify` commands in section 7.

`apps/web/public/_headers` and `apps/web/public/_redirects` ship the security
headers and SPA fallback, respectively.

## 7. Twilio setup

The repo includes [`scripts/twilio-sync.ts`](../scripts/twilio-sync.ts) that
performs all of the following from a single command.

### 7.1. TwiML App

1. Twilio Console → _Voice → Manage → TwiML Apps → Create_.
2. **Voice URL:** `https://api.bestsoftphone.site/webhooks/twilio/voice/outbound`
3. **Voice Status Callback:** `https://api.bestsoftphone.site/webhooks/twilio/voice/status`
4. Copy the App SID into `TWILIO_TWIML_APP_SID`.

### 7.2. API Key

Twilio Console → _Account → API Keys → Create Standard_. Copy the SID into
`TWILIO_API_KEY_SID` and the secret into `TWILIO_API_KEY_SECRET`. The browser
never sees these — they only mint Voice Access Tokens.

### 7.3. Numbers (Voice + Messaging webhooks)

Either purchase via the UI (`/numbers/new`) — the app configures all webhooks
automatically — or, for already-owned numbers, run:

```bash
pnpm tsx scripts/twilio-sync.ts all --owner=<USER_ID>
```

This:

1. lists every `IncomingPhoneNumber` on the Twilio account,
2. imports any that are not in the DB,
3. overwrites their webhook URLs with the production base URL,
4. verifies the result, exiting non-zero on mismatch.

The five webhook URLs that must be configured per number:

```
Voice inbound:     POST https://api.bestsoftphone.site/webhooks/twilio/voice/inbound
Voice fallback:    POST https://api.bestsoftphone.site/webhooks/twilio/voice/fallback
Voice status:      POST https://api.bestsoftphone.site/webhooks/twilio/voice/status
Messaging inbound: POST https://api.bestsoftphone.site/webhooks/twilio/messaging/inbound
Messaging status:  POST https://api.bestsoftphone.site/webhooks/twilio/messaging/status
```

## 8. First-time owner bootstrap

The API enforces that the owner can only be created **once**, and only when
`BOOTSTRAP_TOKEN` is set in env.

```bash
curl -X POST https://api.bestsoftphone.site/api/auth/bootstrap-owner \
  -H 'Content-Type: application/json' \
  -d '{ "email": "owner@example.com", "password": "<strong>", "token": "<BOOTSTRAP_TOKEN>" }'
```

Then **immediately** unset `BOOTSTRAP_TOKEN` (Fly: `fly secrets unset
BOOTSTRAP_TOKEN`) and redeploy.

## 9. Smoke tests

After every deploy run:

```bash
curl -fsS https://api.bestsoftphone.site/api/health
curl -fsS https://api.bestsoftphone.site/api/health/db
curl -fsS https://api.bestsoftphone.site/api/health/redis
curl -fsS https://api.bestsoftphone.site/api/health/twilio
```

Then load `https://app.bestsoftphone.site`, log in, open
`/settings/diagnostics`. Every check should be green.

## 10. Migrations & rollback

- Migrations run on every release (`release_command` on Fly, `CMD` on Render).
- Schema changes are forward-only — Prisma migrations are append-only files
  under `apps/api/prisma/migrations/`.
- Rollback strategy: redeploy the previous Docker image tag in Fly; the new
  schema continues to support old code because every Prisma migration in this
  repo is additive.

## 11. CI/CD

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs install +
typecheck + lint + tests + build on every PR and `main` push. Add a deploy
workflow that runs after `main` passes CI:

- Build and push the Docker image with `gh actions/checkout@v4` →
  `docker/setup-buildx-action@v3` → `docker/build-push-action@v6`
  (Dockerfile: `deploy/api.Dockerfile`).
- Deploy by calling `flyctl deploy --remote-only` with `FLY_API_TOKEN`.
- Cloudflare Pages auto-builds on every push to `main` via the dashboard
  integration; no CLI step is required.

See [`OPERATIONS.md`](OPERATIONS.md) for the day-2 runbook and
[`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) for incident response.
