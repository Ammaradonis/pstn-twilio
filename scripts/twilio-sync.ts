/**
 * scripts/twilio-sync.ts
 *
 * Thin re-export of the operational script that lives at
 * `apps/api/scripts/twilio-sync.ts`. It lives in the api workspace because it
 * depends on `@prisma/client` and `twilio`, which are workspace-scoped to the
 * api package — they are not hoisted to the repo root.
 *
 * This file is preserved only so existing docs/CI that reference
 * `scripts/twilio-sync.ts` keep working. New invocations should prefer:
 *
 *   pnpm --filter @pstn-twilio/api exec tsx --env-file=../../.env scripts/twilio-sync.ts <mode>
 */

import '../apps/api/scripts/twilio-sync.js';
