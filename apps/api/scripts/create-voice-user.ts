/**
 * scripts/create-voice-user.ts
 *
 * Creates (or updates) an account that signs in to the phone-style voice app
 * and gives it a number. The number's incoming calls then ring that account's
 * devices and linked phones, with voicemail; call history starts fresh for it.
 *
 * Usage (from apps/api, with the root .env loaded):
 *
 *   VOICE_USER_PASSWORD='…' npx tsx scripts/create-voice-user.ts \
 *     --email=test@example.com --number=+18776524532 [--route-calls]
 *
 *   --route-calls  also points the number's Twilio voice webhooks at the app
 *                  (inbound, fallback, status callback), like "Configure webhooks".
 *
 * The password comes from VOICE_USER_PASSWORD so it never appears in shell
 * history; it is only set when the account is created or --reset-password is given.
 */

import { PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import twilio from 'twilio';

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const email = arg('email')?.trim().toLowerCase();
  const numberE164 = arg('number')?.trim();
  const password = process.env.VOICE_USER_PASSWORD;
  if (!email || !numberE164 || !/^\+[1-9]\d{6,14}$/.test(numberE164)) {
    throw new Error('Usage: --email=<email> --number=<E.164> [--route-calls] [--reset-password]');
  }

  const prisma = new PrismaClient();
  try {
    const number = await prisma.phoneNumber.findUnique({ where: { phoneNumberE164: numberE164 } });
    if (!number || number.releasedAt)
      throw new Error(`${numberE164} is not an active number in the app`);

    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      if (!password || password.length < 8)
        throw new Error('Set VOICE_USER_PASSWORD (8+ characters)');
      user = await prisma.user.create({
        data: {
          email,
          passwordHash: await argon2.hash(password),
          role: UserRole.OPERATOR,
          experience: 'voice',
        },
      });
      console.log(`Created ${email} (${user.id})`);
    } else {
      if (user.role === UserRole.OWNER)
        throw new Error(`${email} is an owner; refusing to change it`);
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          experience: 'voice',
          disabledAt: null,
          ...(flag('reset-password') && password
            ? { passwordHash: await argon2.hash(password) }
            : {}),
        },
      });
      console.log(`Updated ${email} (${user.id})`);
    }

    // History starts now: earlier calls and texts on the number belong to its previous owner.
    await prisma.voiceSettings.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id, historyStartsAt: new Date() },
    });

    if (number.userId !== user.id) {
      await prisma.phoneNumber.update({ where: { id: number.id }, data: { userId: user.id } });
      console.log(`Assigned ${numberE164} to ${email} (was ${number.userId ?? 'unassigned'})`);
    } else {
      console.log(`${numberE164} already belongs to ${email}`);
    }

    if (flag('route-calls')) {
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const base = (process.env.TWILIO_WEBHOOK_BASE_URL ?? process.env.PUBLIC_BASE_URL)?.replace(
        /\/$/,
        '',
      );
      if (!accountSid || !authToken || !base) {
        throw new Error(
          'TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WEBHOOK_BASE_URL are required',
        );
      }
      const voiceUrl = `${base}/webhooks/twilio/voice/inbound`;
      const statusCallback = `${base}/webhooks/twilio/voice/status`;
      await twilio(accountSid, authToken)
        .api.v2010.accounts(accountSid)
        .incomingPhoneNumbers(number.twilioIncomingPhoneNumberSid)
        .update({
          voiceUrl,
          voiceMethod: 'POST',
          voiceFallbackUrl: `${base}/webhooks/twilio/voice/fallback`,
          voiceFallbackMethod: 'POST',
          statusCallback,
          statusCallbackMethod: 'POST',
        });
      await prisma.phoneNumber.update({
        where: { id: number.id },
        data: { voiceWebhookUrl: voiceUrl, statusCallbackUrl: statusCallback },
      });
      console.log(`Incoming calls to ${numberE164} now go to ${voiceUrl}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
