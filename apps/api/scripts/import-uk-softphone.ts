/** Import the newest UK number without purchasing a number or changing existing lines.
 * Run from apps/api: pnpm exec tsx --env-file=.env scripts/import-uk-softphone.ts [--apply]
 */
import { PrismaClient } from '@prisma/client';
import twilio from 'twilio';

const prisma = new PrismaClient();
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const base = (process.env.TWILIO_WEBHOOK_BASE_URL ?? process.env.PUBLIC_BASE_URL ?? '').replace(
  /\/$/,
  '',
);
const apply = process.argv.includes('--apply');

async function main() {
  if (!base.startsWith('https://')) throw new Error('A public HTTPS webhook base is required.');
  const numbers = await client.incomingPhoneNumbers.list({ limit: 1000 });
  const target = [...numbers].sort((a, b) => b.dateCreated.getTime() - a.dateCreated.getTime())[0];
  if (!target?.phoneNumber.startsWith('+44') || !target.capabilities.voice || target.trunkSid) {
    throw new Error(
      'The newest number must be a voice-capable UK number without SIP trunk routing.',
    );
  }
  const peers = await prisma.phoneNumber.findMany({
    where: {
      active: true,
      twilioIncomingPhoneNumberSid: {
        in: numbers.filter((n) => n.sid !== target.sid).map((n) => n.sid),
      },
    },
    select: { userId: true },
  });
  const owners = [
    ...new Set(peers.map((row) => row.userId).filter((id): id is string => Boolean(id))),
  ];
  if (owners.length !== 1)
    throw new Error('Cannot infer a single owner from the existing active numbers.');
  const existing = await prisma.phoneNumber.findFirst({
    where: {
      OR: [{ twilioIncomingPhoneNumberSid: target.sid }, { phoneNumberE164: target.phoneNumber }],
    },
  });
  if (
    existing &&
    (existing.userId !== owners[0] || existing.twilioIncomingPhoneNumberSid !== target.sid)
  ) {
    throw new Error('The database number is already assigned differently.');
  }
  const permissions = await client.voice.v1.dialingPermissions.countries('GB').fetch();
  if (!permissions.lowRiskNumbersEnabled)
    throw new Error('UK outbound dialing is disabled on this account.');
  console.info(
    JSON.stringify({
      number: target.phoneNumber,
      sid: target.sid,
      purchasedAt: target.dateCreated,
      owner: owners[0],
      previousVoiceUrl: target.voiceUrl,
      capabilities: target.capabilities,
      apply,
    }),
  );
  if (!apply) return;
  for (const endpoint of ['inbound', 'reject', 'fallback']) {
    const url = `${base}/webhooks/twilio/voice/${endpoint}`;
    const result = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': twilio.getExpectedTwilioSignature(
          process.env.TWILIO_AUTH_TOKEN!,
          url,
          {},
        ),
      },
      body: '',
    });
    if (!result.ok || !(await result.text()).includes('<Reject reason="busy"/>'))
      throw new Error(`Inbound policy probe failed: ${endpoint}`);
  }
  const row =
    existing ??
    (await prisma.phoneNumber.create({
      data: {
        userId: owners[0],
        twilioAccountSid: target.accountSid,
        twilioIncomingPhoneNumberSid: target.sid,
        phoneNumberE164: target.phoneNumber,
        country: 'GB',
        numberType: target.phoneNumber.startsWith('+447') ? 'MOBILE' : 'UNKNOWN',
        friendlyName: target.friendlyName,
        purchasedAt: target.dateCreated,
        active: false,
        capabilitiesVoice: target.capabilities.voice,
        capabilitiesSms: target.capabilities.sms,
        capabilitiesMms: target.capabilities.mms,
        tags: { recordInboundCalls: false },
      },
    }));
  const routing = {
    voiceUrl: `${base}/webhooks/twilio/voice/inbound`,
    voiceMethod: 'POST',
    voiceApplicationSid: '',
    voiceFallbackUrl: `${base}/webhooks/twilio/voice/reject`,
    voiceFallbackMethod: 'POST',
    statusCallback: `${base}/webhooks/twilio/voice/status`,
    statusCallbackMethod: 'POST',
    smsUrl: `${base}/webhooks/twilio/messaging/inbound`,
    smsMethod: 'POST',
    smsApplicationSid: '',
    smsFallbackUrl: `${base}/webhooks/twilio/messaging/inbound`,
    smsFallbackMethod: 'POST',
  };
  await client.incomingPhoneNumbers(target.sid).update(routing);
  const verified = await client.incomingPhoneNumbers(target.sid).fetch();
  for (const [key, value] of Object.entries(routing)) {
    if (verified[key as keyof typeof verified] !== value)
      throw new Error(`Twilio did not retain ${key}.`);
  }
  await prisma.phoneNumber.update({
    where: { id: row.id },
    data: {
      country: 'GB',
      active: true,
      releasedAt: null,
      voiceWebhookUrl: routing.voiceUrl,
      smsWebhookUrl: routing.smsUrl,
      statusCallbackUrl: routing.statusCallback,
    },
  });
  console.info(
    JSON.stringify({
      number: target.phoneNumber,
      numberId: row.id,
      status: 'configured',
      inboundRecording: (row.tags as Record<string, unknown> | null)?.recordInboundCalls === true,
    }),
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
