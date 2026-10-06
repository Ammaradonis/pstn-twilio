/**
 * scripts/recon-voice-accounts.ts  (read-only)
 *
 * Prints the current account/number wiring so voice-app work can be planned
 * without guessing. Writes nothing.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      role: true,
      experience: true,
      disabledAt: true,
      createdAt: true,
      lastLoginAt: true,
      _count: {
        select: {
          phoneNumbers: true,
          voiceIdentities: true,
          devices: true,
          contacts: true,
          blockedNumbers: true,
          forwardingNumbers: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\n=== USERS (${users.length}) ===`);
  for (const u of users) {
    console.log(
      [
        u.experience.padEnd(8),
        u.role.padEnd(9),
        u.email.padEnd(28),
        `disabled=${u.disabledAt ? 'YES' : 'no'}`,
        `numbers=${u._count.phoneNumbers}`,
        `identities=${u._count.voiceIdentities}`,
        `devices=${u._count.devices}`,
        `contacts=${u._count.contacts}`,
        `blocked=${u._count.blockedNumbers}`,
        `fwd=${u._count.forwardingNumbers}`,
        u.id,
      ].join('  '),
    );
  }

  const numbers = await prisma.phoneNumber.findMany({
    select: {
      id: true,
      phoneNumberE164: true,
      friendlyName: true,
      userId: true,
      active: true,
      releasedAt: true,
      capabilitiesVoice: true,
      capabilitiesSms: true,
      numberType: true,
      voiceWebhookUrl: true,
      smsWebhookUrl: true,
      statusCallbackUrl: true,
      twilioIncomingPhoneNumberSid: true,
      purchasedAt: true,
    },
    orderBy: { purchasedAt: 'asc' },
  });

  const emailById = new Map(users.map((u) => [u.id, u.email]));
  console.log(`\n=== NUMBERS (${numbers.length}) ===`);
  for (const n of numbers) {
    console.log(
      [
        n.phoneNumberE164.padEnd(16),
        `voice=${n.capabilitiesVoice ? 'Y' : 'n'}`,
        `sms=${n.capabilitiesSms ? 'Y' : 'n'}`,
        `${n.numberType}`.padEnd(9),
        `active=${n.active ? 'Y' : 'n'}`,
        `released=${n.releasedAt ? 'YES' : 'no'}`,
        `owner=${n.userId ? (emailById.get(n.userId) ?? n.userId) : 'UNASSIGNED'}`,
      ].join('  '),
    );
    console.log(`    voiceWebhook=${n.voiceWebhookUrl ?? '-'}`);
    console.log(`    smsWebhook  =${n.smsWebhookUrl ?? '-'}`);
    console.log(`    statusCb    =${n.statusCallbackUrl ?? '-'}`);
    console.log(`    sid=${n.twilioIncomingPhoneNumberSid}  id=${n.id}`);
  }

  const settings = await prisma.voiceSettings.findMany();
  console.log(`\n=== VOICE SETTINGS (${settings.length}) ===`);
  for (const s of settings) {
    console.log(
      `${emailById.get(s.userId) ?? s.userId}: historyStartsAt=${s.historyStartsAt.toISOString()} ringDevices=${s.ringDevices} screenCalls=${s.screenCalls} ringSeconds=${s.ringSeconds} dnd=${s.doNotDisturb} vm=${s.voicemailEnabled} greeting=${s.greetingMode}`,
    );
  }

  const identities = await prisma.voiceIdentity.findMany({
    select: { identity: true, label: true, userId: true, phoneNumberId: true },
  });
  console.log(`\n=== VOICE IDENTITIES (${identities.length}) ===`);
  for (const i of identities) {
    console.log(
      `${i.identity.padEnd(40)} label=${i.label ?? '-'} user=${emailById.get(i.userId) ?? i.userId} numberId=${i.phoneNumberId ?? '-'}`,
    );
  }

  const [calls, sms] = await Promise.all([prisma.call.count(), prisma.smsMessage.count()]);
  console.log(`\n=== VOLUME ===\ncalls=${calls} sms=${sms}`);

  const recentCalls = await prisma.call.findMany({
    select: {
      direction: true,
      status: true,
      fromE164: true,
      toE164: true,
      createdAt: true,
      handledBy: true,
      phoneNumberId: true,
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  console.log('\n=== 5 MOST RECENT CALLS ===');
  for (const c of recentCalls) {
    console.log(
      `${c.createdAt.toISOString()} ${c.direction.padEnd(8)} ${c.status.padEnd(11)} ${c.fromE164} -> ${c.toE164} handledBy=${c.handledBy ?? '-'}`,
    );
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
