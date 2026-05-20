# Playwright E2E suite

These tests run against the **production-built** Vite bundle via `pnpm preview`.
Every `/api/*` request is intercepted with `page.route(...)`, so the suite is
fully hermetic — no Twilio, no Postgres, no Redis, no live backend required.

## Run locally

```bash
# from repo root
pnpm --filter @pstn-twilio/web build
pnpm --filter @pstn-twilio/web exec playwright install --with-deps chromium   # first run
pnpm --filter @pstn-twilio/web test:e2e
```

`playwright.config.ts` automatically starts `pnpm preview` on port `4173` if
`E2E_BASE_URL` isn't set.

## Run against a different base URL

```bash
E2E_BASE_URL=https://app.webfitalchemist.online pnpm --filter @pstn-twilio/web test:e2e
```

In that mode the API mocks still apply (they intercept any `**/api/*`), so a
green run against a deployed URL only proves that the asset bundle and the
client-side router are healthy — it does NOT exercise the real backend. For
that, see `docs/PRODUCTION_CHECKLIST.md`.

## Coverage

| File                   | Scenario                                              |
| ---------------------- | ----------------------------------------------------- |
| `smoke.e2e.test.ts`    | unauthenticated `/` → `/login` redirect.              |
| `auth.e2e.test.ts`     | login redirect, wrong password, happy path, sign out. |
| `numbers.e2e.test.ts`  | list provisioned numbers, open detail page.           |
| `messages.e2e.test.ts` | inbox shows inbound SMS, sending a reply works.       |

The voice/dial pages are exercised by the Phase 8 unit tests for the Twilio
Device hook; they are not covered here because the Twilio Voice SDK requires
real WebRTC/audio devices that are not available in headless Chromium without
flags.
