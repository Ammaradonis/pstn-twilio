/**
 * scripts/twilio-sync.ts
 *
 * Operational sync tool between the live Twilio account and the app's database.
 *
 *   - list     : list all IncomingPhoneNumbers on the Twilio account, side by side with our DB
 *   - import   : pull numbers from Twilio into the DB (no-op if already present)
 *   - configure: rewrite webhook URLs on Twilio so they point at our PUBLIC_BASE_URL
 *   - verify   : flag mismatches between Twilio's view and the DB
 *
 * Usage (from repo root):
 *
 *   pnpm tsx scripts/twilio-sync.ts list
 *   pnpm tsx scripts/twilio-sync.ts import      --owner=<USER_ID>
 *   pnpm tsx scripts/twilio-sync.ts configure
 *   pnpm tsx scripts/twilio-sync.ts verify
 *   pnpm tsx scripts/twilio-sync.ts all         --owner=<USER_ID>   # import + configure + verify
 *
 * Required env (loaded from .env if present):
 *   TWILIO_ACCOUNT_SID
 *   TWILIO_AUTH_TOKEN
 *   PUBLIC_BASE_URL                    (or TWILIO_WEBHOOK_BASE_URL)
 *   DATABASE_URL
 *
 * The script writes nothing to Twilio in `list` / `verify` modes — those are read-only.
 */

import { PrismaClient, WhatsAppCompatibilityStatus } from '@prisma/client';
import twilio from 'twilio';

type Mode = 'list' | 'import' | 'configure' | 'verify' | 'all';

interface CliArgs {
  mode: Mode;
  ownerUserId: string | null;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const [mode, ...rest] = argv;
  if (!mode || !['list', 'import', 'configure', 'verify', 'all'].includes(mode)) {
    throw new Error(
      `Usage: twilio-sync.ts <list|import|configure|verify|all> [--owner=<USER_ID>] [--dry-run]`,
    );
  }
  let ownerUserId: string | null = null;
  let dryRun = false;
  for (const arg of rest) {
    if (arg.startsWith('--owner=')) ownerUserId = arg.slice('--owner='.length);
    else if (arg === '--dry-run') dryRun = true;
  }
  return { mode: mode as Mode, ownerUserId, dryRun };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function webhookUrls(base: string) {
  const trimmed = base.replace(/\/$/, '');
  return {
    voiceUrl: `${trimmed}/webhooks/twilio/voice/inbound`,
    voiceFallbackUrl: `${trimmed}/webhooks/twilio/voice/fallback`,
    statusCallback: `${trimmed}/webhooks/twilio/voice/status`,
    smsUrl: `${trimmed}/webhooks/twilio/messaging/inbound`,
    smsFallbackUrl: `${trimmed}/webhooks/twilio/messaging/inbound`,
  };
}

function summarizeCaps(caps: Record<string, boolean | undefined>) {
  return {
    voice: caps.voice === true,
    sms: caps.SMS === true || caps.sms === true,
    mms: caps.MMS === true || caps.mms === true,
  };
}

async function listMode(prisma: PrismaClient, client: ReturnType<typeof twilio>) {
  const [twilioNumbers, dbNumbers] = await Promise.all([
    client.incomingPhoneNumbers.list({ limit: 1000 }),
    prisma.phoneNumber.findMany({}),
  ]);
  const dbBySid = new Map(dbNumbers.map((n) => [n.twilioIncomingPhoneNumberSid, n]));
  const dbByE164 = new Map(dbNumbers.map((n) => [n.phoneNumberE164, n]));

  console.log(
    `Twilio: ${twilioNumbers.length} number(s) on account, DB: ${dbNumbers.length} row(s).`,
  );
  for (const t of twilioNumbers) {
    const matched = dbBySid.get(t.sid) ?? dbByE164.get(t.phoneNumber) ?? null;
    console.log(
      `  ${t.phoneNumber.padEnd(16)} sid=${t.sid}  ${matched ? `db=${matched.id} (active=${matched.active})` : 'NOT_IN_DB'}`,
    );
  }
  const orphans = dbNumbers.filter(
    (d) => !twilioNumbers.some((t) => t.sid === d.twilioIncomingPhoneNumberSid),
  );
  for (const o of orphans) {
    console.log(
      `  ${o.phoneNumberE164.padEnd(16)} sid=${o.twilioIncomingPhoneNumberSid}  IN_DB_NOT_IN_TWILIO`,
    );
  }
}

async function importMode(
  prisma: PrismaClient,
  client: ReturnType<typeof twilio>,
  ownerUserId: string,
  webhooks: ReturnType<typeof webhookUrls>,
  accountSid: string,
  dryRun: boolean,
) {
  const owner = await prisma.user.findUnique({ where: { id: ownerUserId } });
  if (!owner) throw new Error(`Owner user ${ownerUserId} not found`);

  await prisma.twilioAccount.upsert({
    where: { accountSid },
    update: {},
    create: { accountSid, friendlyName: 'twilio-sync', isDefault: false },
  });

  const twilioNumbers = await client.incomingPhoneNumbers.list({ limit: 1000 });
  let imported = 0;
  let skipped = 0;
  for (const t of twilioNumbers) {
    const existing = await prisma.phoneNumber.findFirst({
      where: {
        OR: [{ twilioIncomingPhoneNumberSid: t.sid }, { phoneNumberE164: t.phoneNumber }],
      },
    });
    if (existing) {
      skipped += 1;
      continue;
    }
    const caps = summarizeCaps((t.capabilities ?? {}) as Record<string, boolean | undefined>);
    if (dryRun) {
      console.log(`would import ${t.phoneNumber} (${t.sid})`);
      imported += 1;
      continue;
    }
    await prisma.phoneNumber.create({
      data: {
        userId: ownerUserId,
        twilioAccountSid: t.accountSid ?? accountSid,
        twilioIncomingPhoneNumberSid: t.sid,
        phoneNumberE164: t.phoneNumber,
        friendlyName: t.friendlyName ?? t.phoneNumber,
        country:
          (t as unknown as { isoCountry?: string }).isoCountry ??
          process.env.TWILIO_DEFAULT_COUNTRY ??
          'US',
        capabilitiesVoice: caps.voice,
        capabilitiesSms: caps.sms,
        capabilitiesMms: caps.mms,
        whatsappCompatibilityStatus: WhatsAppCompatibilityStatus.NOT_GUARANTEED,
        voiceWebhookUrl: t.voiceUrl ?? webhooks.voiceUrl,
        smsWebhookUrl: t.smsUrl ?? webhooks.smsUrl,
        statusCallbackUrl: t.statusCallback ?? webhooks.statusCallback,
        active: true,
      },
    });
    imported += 1;
  }
  console.log(`Import complete: imported=${imported} skipped=${skipped}`);
}

async function configureMode(
  prisma: PrismaClient,
  client: ReturnType<typeof twilio>,
  webhooks: ReturnType<typeof webhookUrls>,
  dryRun: boolean,
) {
  const rows = await prisma.phoneNumber.findMany({ where: { releasedAt: null, active: true } });
  let updated = 0;
  for (const row of rows) {
    if (dryRun) {
      console.log(`would configure ${row.phoneNumberE164} (${row.twilioIncomingPhoneNumberSid})`);
      updated += 1;
      continue;
    }
    try {
      await client.incomingPhoneNumbers(row.twilioIncomingPhoneNumberSid).update({
        voiceUrl: webhooks.voiceUrl,
        voiceFallbackUrl: webhooks.voiceFallbackUrl,
        voiceMethod: 'POST',
        statusCallback: webhooks.statusCallback,
        statusCallbackMethod: 'POST',
        smsUrl: webhooks.smsUrl,
        smsFallbackUrl: webhooks.smsFallbackUrl,
        smsMethod: 'POST',
      });
      await prisma.phoneNumber.update({
        where: { id: row.id },
        data: {
          voiceWebhookUrl: webhooks.voiceUrl,
          smsWebhookUrl: webhooks.smsUrl,
          statusCallbackUrl: webhooks.statusCallback,
        },
      });
      updated += 1;
      console.log(`configured ${row.phoneNumberE164}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown';
      console.error(`failed to configure ${row.phoneNumberE164}: ${message}`);
    }
  }
  console.log(`Configure complete: updated=${updated} / total=${rows.length}`);
}

async function verifyMode(
  prisma: PrismaClient,
  client: ReturnType<typeof twilio>,
  webhooks: ReturnType<typeof webhookUrls>,
): Promise<boolean> {
  const [twilioNumbers, dbNumbers] = await Promise.all([
    client.incomingPhoneNumbers.list({ limit: 1000 }),
    prisma.phoneNumber.findMany({ where: { releasedAt: null } }),
  ]);
  const twilioBySid = new Map(twilioNumbers.map((t) => [t.sid, t]));
  let mismatches = 0;

  for (const row of dbNumbers) {
    const t = twilioBySid.get(row.twilioIncomingPhoneNumberSid);
    if (!t) {
      console.warn(`MISMATCH (missing-on-twilio): db ${row.phoneNumberE164}`);
      mismatches += 1;
      continue;
    }
    if (t.phoneNumber !== row.phoneNumberE164) {
      console.warn(
        `MISMATCH (phone-number): db=${row.phoneNumberE164} twilio=${t.phoneNumber} sid=${t.sid}`,
      );
      mismatches += 1;
    }
    if (t.voiceUrl !== webhooks.voiceUrl) {
      console.warn(
        `MISMATCH (voiceUrl): ${row.phoneNumberE164} db-expected=${webhooks.voiceUrl} twilio=${t.voiceUrl}`,
      );
      mismatches += 1;
    }
    if (t.smsUrl !== webhooks.smsUrl) {
      console.warn(
        `MISMATCH (smsUrl): ${row.phoneNumberE164} db-expected=${webhooks.smsUrl} twilio=${t.smsUrl}`,
      );
      mismatches += 1;
    }
    if (t.statusCallback !== webhooks.statusCallback) {
      console.warn(
        `MISMATCH (statusCallback): ${row.phoneNumberE164} db-expected=${webhooks.statusCallback} twilio=${t.statusCallback}`,
      );
      mismatches += 1;
    }
    const caps = summarizeCaps((t.capabilities ?? {}) as Record<string, boolean | undefined>);
    if (caps.voice !== row.capabilitiesVoice) {
      console.warn(
        `MISMATCH (capabilities.voice): ${row.phoneNumberE164} db=${row.capabilitiesVoice} twilio=${caps.voice}`,
      );
      mismatches += 1;
    }
    if (caps.sms !== row.capabilitiesSms) {
      console.warn(
        `MISMATCH (capabilities.sms): ${row.phoneNumberE164} db=${row.capabilitiesSms} twilio=${caps.sms}`,
      );
      mismatches += 1;
    }
  }

  for (const t of twilioNumbers) {
    if (!dbNumbers.some((d) => d.twilioIncomingPhoneNumberSid === t.sid)) {
      console.warn(`MISMATCH (missing-in-db): twilio ${t.phoneNumber} sid=${t.sid}`);
      mismatches += 1;
    }
  }

  console.log(`Verify complete: mismatches=${mismatches}`);
  return mismatches === 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const accountSid = requireEnv('TWILIO_ACCOUNT_SID');
  const authToken = requireEnv('TWILIO_AUTH_TOKEN');
  const base = process.env.PUBLIC_BASE_URL ?? process.env.TWILIO_WEBHOOK_BASE_URL;
  if (!base) throw new Error('PUBLIC_BASE_URL or TWILIO_WEBHOOK_BASE_URL is required');

  const prisma = new PrismaClient();
  const client = twilio(accountSid, authToken);
  const webhooks = webhookUrls(base);

  try {
    if (args.mode === 'list') {
      await listMode(prisma, client);
    } else if (args.mode === 'import') {
      if (!args.ownerUserId) throw new Error('--owner=<USER_ID> is required for import');
      await importMode(prisma, client, args.ownerUserId, webhooks, accountSid, args.dryRun);
    } else if (args.mode === 'configure') {
      await configureMode(prisma, client, webhooks, args.dryRun);
    } else if (args.mode === 'verify') {
      const ok = await verifyMode(prisma, client, webhooks);
      process.exitCode = ok ? 0 : 1;
    } else if (args.mode === 'all') {
      if (!args.ownerUserId) throw new Error('--owner=<USER_ID> is required for all');
      await importMode(prisma, client, args.ownerUserId, webhooks, accountSid, args.dryRun);
      await configureMode(prisma, client, webhooks, args.dryRun);
      const ok = await verifyMode(prisma, client, webhooks);
      process.exitCode = ok ? 0 : 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
