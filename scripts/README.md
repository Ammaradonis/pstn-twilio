# scripts

Operational scripts for the `pstn-twilio` project. All scripts are run via
[`tsx`](https://www.npmjs.com/package/tsx) so they can use the same TypeScript
sources as the apps.

## `twilio-sync.ts`

Bi-directional reconciliation tool between the live Twilio account and the
app's database. Use it to:

- inventory the gap between Twilio and the DB,
- import existing Twilio numbers into the DB,
- (re)configure every number's webhook URLs so they hit `PUBLIC_BASE_URL`,
- verify that every number's Twilio config matches the DB.

The real script lives at `apps/api/scripts/twilio-sync.ts` because it depends
on `@prisma/client` and `twilio`, which are workspace-scoped to the api
package. The file under `scripts/` here is a thin re-export kept for
backwards compatibility with existing docs/CI references.

### Usage

```bash
# read-only inventory of Twilio numbers and DB rows
pnpm --filter @pstn-twilio/api exec tsx --env-file=../../.env scripts/twilio-sync.ts list

# import all Twilio numbers into the DB, owned by <USER_ID>
pnpm --filter @pstn-twilio/api exec tsx --env-file=../../.env scripts/twilio-sync.ts import --owner=<USER_ID>

# overwrite the webhook URLs on Twilio so they point at PUBLIC_BASE_URL
pnpm --filter @pstn-twilio/api exec tsx --env-file=../../.env scripts/twilio-sync.ts configure

# diff DB vs Twilio (exits non-zero if mismatches found)
pnpm --filter @pstn-twilio/api exec tsx --env-file=../../.env scripts/twilio-sync.ts verify

# import + configure + verify in one go
pnpm --filter @pstn-twilio/api exec tsx --env-file=../../.env scripts/twilio-sync.ts all --owner=<USER_ID>
```

Pass `--dry-run` to `import` / `configure` / `all` to print the actions
without writing anything.

### Required env

The script reads from `process.env`, so source your `.env` first or pass
inline:

| Variable                                           | Purpose                                      |
| -------------------------------------------------- | -------------------------------------------- |
| `TWILIO_ACCOUNT_SID`                               | Twilio account                               |
| `TWILIO_AUTH_TOKEN`                                | Twilio account auth token                    |
| `PUBLIC_BASE_URL` _(or `TWILIO_WEBHOOK_BASE_URL`)_ | Public URL the webhooks will be rewritten to |
| `DATABASE_URL`                                     | Postgres connection string                   |
| `TWILIO_DEFAULT_COUNTRY`                           | _(optional)_ fallback country code on import |

The script never prints secrets and never updates Twilio in `list` or
`verify` modes. `configure` and `import` are the only modes that mutate state.
