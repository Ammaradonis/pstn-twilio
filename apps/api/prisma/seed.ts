import { PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const ownerEmail = process.env.OWNER_EMAIL || 'owner@example.com';
  const ownerPassword = process.env.OWNER_INITIAL_PASSWORD || 'ChangeMe123!';

  // Check if owner already exists
  const existingOwner = await prisma.user.findUnique({
    where: { email: ownerEmail },
  });

  if (existingOwner) {
    console.log('Owner user already exists.');
    return;
  }

  // Hash password
  const passwordHash = await argon2.hash(ownerPassword);

  // Create owner user
  await prisma.user.create({
    data: {
      email: ownerEmail,
      passwordHash,
      role: UserRole.OWNER,
    },
  });

  console.log('✅ Created owner user.');
  console.log(`⚠️  Please change this password immediately after first login!`);

  // Create default Twilio account placeholder (will be configured later)
  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
  if (twilioAccountSid) {
    const existingAccount = await prisma.twilioAccount.findUnique({
      where: { accountSid: twilioAccountSid },
    });

    if (!existingAccount) {
      await prisma.twilioAccount.create({
        data: {
          accountSid: twilioAccountSid,
          friendlyName: 'Default Twilio Account',
          isDefault: true,
        },
      });
      console.log('✅ Created Twilio account.');
    }
  }
}

main()
  .catch(() => {
    console.error('❌ Seed failed. Check database connectivity and configuration.');
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
