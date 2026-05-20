# pstn-twilio

A single-owner web app that provisions Twilio phone numbers, receives and sends SMS,
and answers/places PSTN calls in the browser via the Twilio Voice JavaScript SDK.

> WhatsApp compatibility is **not guaranteed**. Some VoIP, toll-free, landline, or
> virtual numbers may be unsupported by WhatsApp/Meta.

## Stack

- **Frontend:** Vite + React + TypeScript + Tailwind + React Router + TanStack Query + Zustand + `@twilio/voice-sdk` + `socket.io-client`
- **Backend:** NestJS + TypeScript + Prisma + PostgreSQL (Neon) + Redis (Upstash) + Twilio Node SDK
- **Realtime:** Socket.IO over WebSockets
- **Hosting:** Cloudflare Pages (web) + Node-friendly host (api), DNS on Cloudflare, domain on Namecheap (`webfitalchemist.online`)

## Layout

```
apps/
  api/        NestJS backend
  web/        Vite React frontend
packages/
  shared/     shared TypeScript types, DTOs, Zod schemas
docs/         RESEARCH.md, ADRs, ARCHITECTURE.md, ...
prisma/       schema + migrations (Phase 4)
scripts/      twilio-sync, dev helpers (Phase 10)
```

## Prerequisites

- Node.js **22.x** (`.nvmrc`)
- pnpm **>= 9** (the repo is tested with 11)
- A PostgreSQL database (Neon recommended)
- A Redis instance (Upstash recommended)
- A Twilio account (Account SID, Auth Token, API Key SID + Secret, TwiML App SID)

## Quick start

```bash
pnpm install
cp .env.example .env   # fill in real values; see docs/DEPLOYMENT.md
pnpm prisma:generate    # generate prisma client
pnpm prisma:migrate     # run migrations (use prisma:migrate:deploy in production)
pnpm dev               # runs api + web concurrently
```

Health check: <https://webfitalchemist.online/api/health>
Frontend: <http://localhost:5173>

## Top-level scripts

| Script           | What it does                                 |
| ---------------- | -------------------------------------------- |
| `pnpm dev`       | Run api + web in parallel                    |
| `pnpm build`     | Build every workspace package                |
| `pnpm typecheck` | `tsc --noEmit` across the workspace          |
| `pnpm lint`      | ESLint across the workspace                  |
| `pnpm format`    | Prettier write across the workspace          |
| `pnpm test`      | Vitest unit tests across the workspace       |
| `pnpm test:e2e`  | Playwright E2E tests (Phase 10)              |
| `pnpm prisma:*`  | Prisma helpers — generate / migrate / studio |

## Documentation

- [`docs/RESEARCH.md`](docs/RESEARCH.md) — Phase-1 research with sources
- [`docs/adr/0001-telephony-architecture.md`](docs/adr/0001-telephony-architecture.md) — Architecture decision record
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — module map + data-flow diagrams
- [`docs/API.md`](docs/API.md) — every HTTP + WebSocket route
- [`docs/SECURITY.md`](docs/SECURITY.md) — threat model + secret handling
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — Cloudflare Pages + Fly.io / Render runbook
- [`docs/TESTING.md`](docs/TESTING.md) — unit / integration / E2E / manual
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — day-2 runbook
- [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) — symptom → fix playbook
- [`docs/MANUAL_TWILIO_CHECKLIST.md`](docs/MANUAL_TWILIO_CHECKLIST.md) — printable 20-step release gate
- [`docs/LAUNCH_CHECKLIST.md`](docs/LAUNCH_CHECKLIST.md) — pre-launch go/no-go

## Security

- `.env` and `env.txt` are gitignored and must never be committed.
- All Twilio webhooks validate the `X-Twilio-Signature` header.
- Secrets are loaded only via `@nestjs/config` and never logged.
- See `docs/SECURITY.md` (Phase 5+).
