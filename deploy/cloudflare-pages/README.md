# Cloudflare Pages — `app.webfitalchemist.online`

The web bundle is a static SPA, so Cloudflare Pages is the simplest target.

## One-time setup

1. **Create the Pages project** in the Cloudflare dashboard (or via `wrangler pages project create pstn-twilio-web`) pointing at the GitHub repository.
2. **Framework preset:** `Vite`.
3. **Build command:** `pnpm -F @pstn-twilio/shared build && pnpm -F @pstn-twilio/web build`
4. **Build output:** `apps/web/dist`
5. **Root directory:** `/` (monorepo root).
6. **Production environment variables:**
   - `VITE_API_BASE_URL = https://api.webfitalchemist.online/api`
   - `VITE_WS_URL       = wss://api.webfitalchemist.online`
   - `VITE_APP_NAME     = pstn-twilio`
   - `VITE_REPEAT_DIAL_WARNING_ENABLED = false`
7. **Copy these files into the deploy** (Cloudflare Pages picks them up
   automatically when they appear at the repository root **or** under
   `apps/web/public/` — copy them at build time):
   - [`_headers`](./_headers) — HSTS, CSP, no-frame, etc.
   - [`_redirects`](./_redirects) — SPA fallback so deep links work.

## Domain

| Hostname                        | DNS record                                          | TLS  |
| ------------------------------- | --------------------------------------------------- | ---- |
| `app.webfitalchemist.online`    | CNAME → `pstn-twilio-web.pages.dev` (proxied)       | Auto |
| `webfitalchemist.online` (apex) | CNAME flat → `app.webfitalchemist.online` (proxied) | Auto |

Make sure the apex domain is pointed at Cloudflare nameservers in Namecheap
first (see [`docs/DEPLOYMENT.md`](../../docs/DEPLOYMENT.md)).
