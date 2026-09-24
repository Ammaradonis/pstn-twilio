/** Audit or apply manual-answer-only inbound routing; never changes SMS or outbound routing.
 * pnpm --filter @pstn-twilio/api exec tsx --env-file=../../.env scripts/inbound-policy.ts [--apply]
 */
import { PrismaClient } from '@prisma/client';
import twilio from 'twilio';

const prisma = new PrismaClient();
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const base = (process.env.TWILIO_WEBHOOK_BASE_URL ?? process.env.PUBLIC_BASE_URL ?? '').replace(
  /\/$/,
  '',
);
if (!base.startsWith('https://')) throw new Error('A public HTTPS webhook base is required.');
const apply = process.argv.includes('--apply');

async function main() {
  const numbers = await client.incomingPhoneNumbers.list({ limit: 1000 });
  const rows = await prisma.phoneNumber.findMany({ where: { active: true } });
  const targets = numbers
    .filter((number) => number.capabilities.voice)
    .map((number) => {
      const row = rows.find((candidate) => candidate.twilioIncomingPhoneNumberSid === number.sid);
      if (!row?.userId || row.phoneNumberE164 !== number.phoneNumber) {
        throw new Error(
          `No active owned browser number matches ${number.phoneNumber}; refusing partial rollout.`,
        );
      }
      if (number.trunkSid)
        throw new Error(`SIP trunk routing must be reviewed for ${number.phoneNumber}.`);
      return { number, row };
    });
  for (const { number, row } of targets) {
    console.info(
      JSON.stringify({
        phoneNumber: number.phoneNumber,
        numberId: row.id,
        voiceUrl: number.voiceUrl,
        voiceApplicationSid: number.voiceApplicationSid,
        voiceFallbackUrl: number.voiceFallbackUrl,
        recordInboundCalls:
          (row.tags as Record<string, unknown> | null)?.recordInboundCalls ?? false,
      }),
    );
  }
  if (!apply) return;
  // Probe without a CallSid: no calls, ringing notifications, or DB records are created.
  const rejectUrl = `${base}/webhooks/twilio/voice/reject`;
  for (const endpoint of [
    'reject',
    'fallback',
    'inbound',
    'dial-complete',
    'voicemail',
    'voicemail/complete',
  ]) {
    const url = `${base}/webhooks/twilio/voice/${endpoint}`;
    const signature = twilio.getExpectedTwilioSignature(process.env.TWILIO_AUTH_TOKEN!, url, {});
    const probe = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Twilio-Signature': signature,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: '',
    });
    if (
      !probe.ok ||
      !(await probe.text()).includes('<Response><Reject reason="busy"/></Response>')
    ) {
      throw new Error(
        `Production ${endpoint} did not pass verification; deploy the new API first.`,
      );
    }
  }
  for (const { number, row } of targets) {
    await prisma.phoneNumber.update({
      where: { id: row.id },
      data: {
        tags: { ...((row.tags ?? {}) as Record<string, never>), recordInboundCalls: false },
      },
    });
    await client.incomingPhoneNumbers(number.sid).update({
      voiceUrl: `${base}/webhooks/twilio/voice/inbound`,
      voiceMethod: 'POST',
      voiceApplicationSid: '',
      voiceFallbackUrl: rejectUrl,
      voiceFallbackMethod: 'POST',
      statusCallback: `${base}/webhooks/twilio/voice/status`,
      statusCallbackMethod: 'POST',
    });
    await prisma.phoneNumber.update({
      where: { id: row.id },
      data: { voiceWebhookUrl: `${base}/webhooks/twilio/voice/inbound` },
    });
    const current = await client.incomingPhoneNumbers(number.sid).fetch();
    if (
      current.voiceUrl !== `${base}/webhooks/twilio/voice/inbound` ||
      current.voiceFallbackUrl !== rejectUrl ||
      current.voiceApplicationSid
    ) {
      throw new Error(`Routing verification failed for ${number.phoneNumber}.`);
    }
    console.info(`${number.phoneNumber}: browser answer only; fallback rejects; recording off.`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Policy update failed');
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
