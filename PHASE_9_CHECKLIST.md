# Phase 9 — Post-Implementation Checklist

## What ships in this phase

### Auth + route protection

- [x] `apps/web/src/lib/auth-store.ts` — Zustand store with `persist` middleware, hydrates the bearer token from `localStorage`, syncs it into `api-client.setToken` on rehydrate so every request gets the JWT, exposes `setSession` / `setUser` / `setStatus` / `logout`.
- [x] `apps/web/src/lib/selected-number-store.ts` — separate persisted store for the active number (used by the global switcher).
- [x] `apps/web/src/components/require-auth.tsx` — gate. Without a token → redirect to `/login` with the original path in `state.from`. With a token → fetch `/auth/me` once and cache the user; on 401/403 it auto-logs out.
- [x] `apps/web/src/pages/login.tsx` — real login form (email / password, autocomplete, submit disabled until valid, error surfacing) hitting `POST /api/auth/login`. Authenticated users hitting `/login` are redirected to the requested target.
- [x] `apps/web/src/app.tsx` — every authenticated route is wrapped in `<RequireAuth>` → `<AppLayout>`; `/login` and the not-found fallback are public.

### Global layout

- [x] `apps/web/src/components/app-layout.tsx`:
  - Top header with brand, **mobile hamburger** that toggles the sidebar, **NumberSwitcher**, **ConnectionStatusBar**, signed-in email, and **Sign out**.
  - Left sidebar (collapses on mobile) split into Primary nav (Dashboard / Numbers / New number) and Secondary nav (Settings / Twilio config / Security).
  - WhatsApp compatibility footnote in the sidebar.
- [x] `apps/web/src/components/number-switcher.tsx` — `<select>` of all provisioned numbers; persists to `selectedNumberId` and routes to the same sub-page (Inbox / Calls / Answer / Dial / Detail) when switching contextually.
- [x] `apps/web/src/components/connection-status.tsx` + `hooks/use-api-health.ts` + `hooks/use-socket-status.ts` — pills for **API** (`/health` polled every 15s) and **Realtime** (Socket.IO `connect` / `disconnect` / `connect_error`). Twilio Device readiness is shown on the Answer / Dial pages where it is initialised.
- [x] `apps/web/src/lib/toast.tsx` — context-based toaster with 4 tones (info / success / warn / error), auto-dismiss, dismiss button, accessible role="status".
- [x] `apps/web/src/components/error-boundary.tsx` — class-based React error boundary at the app root; renders a friendly fallback with stack trace and reset / reload buttons.
- [x] `apps/web/src/main.tsx` — `<ErrorBoundary><QueryClientProvider><ToastProvider><BrowserRouter><App/></BrowserRouter></ToastProvider></QueryClientProvider></ErrorBoundary>`.

### Dashboard

- [x] `apps/web/src/pages/dashboard.tsx`:
  - Stat cards: **Active numbers**, **Need webhook config**, **Recent inbound SMS**, **Recent calls**.
  - Health row: **API**, **Database**, **Redis**, **Twilio credentials** (each polled).
  - **Numbers requiring webhook reconfiguration** alert with deep links.
  - **WhatsApp compatibility** disclaimer.
  - **Recent inbound SMS** list (last 5 across all numbers via `/api/messages/search`).
  - **Recent calls** list (top 5 active numbers, latest 3 calls each, merged + sorted client-side).

### Settings

- [x] `apps/web/src/pages/settings.tsx` — account info card (email, role, created, last login) + quick links.
- [x] `apps/web/src/pages/settings-twilio.tsx` — service health rows (DB / Redis / Twilio credentials), webhook configuration block (inferred webhook base URL + sample voice / SMS / status URLs from a provisioned number, with an HTTPS warning), frontend env block (`VITE_*`).
- [x] `apps/web/src/pages/settings-security.tsx` — change-password form (`oldPassword`, `newPassword`, `confirmPassword`), client-side validation (min 8, must match, must differ), success / error toasts via `useToast`, calls `POST /api/auth/change-password`.

### Pages already built in earlier phases (kept, polished)

- [x] `/numbers/new` (Phase 6)
- [x] `/numbers` (Phase 6) + `/numbers/:numberId` (Phase 6) — now toast-driven on rename / sync / reconfigure / release / deactivate.
- [x] `/numbers/:numberId/messages` (Phase 7) — now toast-driven on send / retry.
- [x] `/numbers/:numberId/calls`, `/numbers/:numberId/answer`, `/numbers/:numberId/dial` (Phase 8).

### API client

- [x] Typed `api.health()` plus `api.health.db/redis/twilio()`.
- [x] `api.auth.changePassword(oldPassword, newPassword)`.
- [x] All other endpoints from Phases 5–8 use the same single `request<T>` helper that injects the bearer token, throws a typed `ApiError` on non-2xx, and returns shared DTO types.

## Routes (final)

| Path                          | Auth     | Notes                                                           |
| ----------------------------- | -------- | --------------------------------------------------------------- |
| `/login`                      | public   | Redirects to `/dashboard` (or `state.from`) when authenticated. |
| `/dashboard`                  | required | Stats, health, recent SMS, recent calls.                        |
| `/numbers`                    | required | Manage / filter provisioned numbers.                            |
| `/numbers/new`                | required | Search + purchase + auto webhook config.                        |
| `/numbers/:numberId`          | required | Detail + lifecycle actions.                                     |
| `/numbers/:numberId/messages` | required | Inbox + compose + retry.                                        |
| `/numbers/:numberId/calls`    | required | Call log (real-time).                                           |
| `/numbers/:numberId/answer`   | required | Browser softphone — incoming.                                   |
| `/numbers/:numberId/dial`     | required | Browser softphone — outbound.                                   |
| `/settings`                   | required | Account overview.                                               |
| `/settings/twilio`            | required | Health + webhook URL + dev diagnostics.                         |
| `/settings/security`          | required | Change password.                                                |
| `*`                           | public   | NotFound page.                                                  |

## Frontend data layer

- All reads use TanStack Query with stable query keys: `['numbers']`, `['numbers', numberId]`, `['messages', numberId]`, `['calls', numberId]`, `['health', '<check>']`, `['messages','search', filters]`.
- All mutations either invalidate the relevant queries or `setQueryData` directly (compose) before refetch.
- WebSocket events update the same TanStack Query cache (Phase 7 SMS hook + Phase 8 calls hook).

## Tests

- `apps/web/src/lib/auth-store.test.ts` — 3 tests: initial state, `setSession` persists token, `logout` clears token + store.
- `apps/web/src/lib/toast.test.tsx` — 1 test: `push()` renders the toast in the toaster.
- `apps/web/src/app.test.tsx` — 3 tests: unauth `/dashboard` → login page is shown, authenticated `/dashboard` renders the heading, unknown route → 404.

```pwsh
pnpm --filter @pstn-twilio/web typecheck   # clean
pnpm --filter @pstn-twilio/web test --run  # 3 files, 7 tests passing
pnpm --filter @pstn-twilio/api typecheck   # clean
pnpm --filter @pstn-twilio/api test --run  # 9 files, 61 tests passing (unchanged)
```

## Manual smoke test

1. `pnpm --filter @pstn-twilio/api dev` and `pnpm --filter @pstn-twilio/web dev`.
2. Open the app — you should be redirected to `/login`.
3. Sign in with the seeded owner account; you should land on `/dashboard`.
4. Stat cards render with live numbers + the four health pills (API / DB / Redis / Twilio).
5. Switch a number from the global switcher in the header — the URL should update to the same sub-route under the new number.
6. Provision a number from `/numbers/new`, confirm the webhook URLs appear in `/settings/twilio` once provisioning is complete.
7. Send an SMS from `/numbers/:id/messages` — confirm the toast and the row in the inbox.
8. Hit a wrong path (`/wat`) — the 404 page renders.
9. Force a runtime error in dev (e.g. throw inside a page) — the ErrorBoundary fallback should appear with the stack and reset button.
10. Click **Sign out** — token is cleared from `localStorage`, you are redirected to `/login`.

## Acceptance criteria (from `10-phase-plan.txt`)

- [x] Minimalistic UI works on desktop and mobile-width screens (sidebar collapses behind a hamburger, layout flexes).
- [x] No secret values exposed client-side (only public Twilio webhook URLs and the user's own JWT are visible; the JWT lives in `localStorage` only).
- [x] All routes except `/login` are protected (`RequireAuth` wraps the entire `AppLayout`).
- [x] Frontend handles Twilio Device errors gracefully (Phase 8 hook + Answer/Dial banners).
- [x] User can complete core flows without using the Twilio Console manually after initial credential setup (provision numbers, configure webhooks, send/receive SMS, place/receive calls, view audit info, change password — all from the UI).
