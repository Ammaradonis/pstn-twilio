import { randomUUID } from 'crypto';

import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

import { loadTemplate, renderTemplate } from './gmail.service';
import { templateVars } from './sheets-follow-up.service';

/** Durable hand-off to the local browser. Only scheduled follow-ups can be claimed. */
@Injectable()
export class ContactFormService {
  constructor(private readonly prisma: PrismaService) {}

  async claim() {
    const now = new Date();
    const stale = new Date(now.getTime() - 15 * 60_000);
    await this.prisma.sheetsPushLog.updateMany({
      where: { emailStatus: 'FORM_PREPARING', updatedAt: { lt: stale } },
      data: { emailStatus: 'PENDING', formLeaseToken: null },
    });
    await this.prisma.sheetsPushLog.updateMany({
      where: { emailStatus: 'FORM_SENDING', updatedAt: { lt: stale } },
      data: {
        emailStatus: 'MANUAL',
        emailError: 'Form submission was interrupted. Check delivery before sending again.',
      },
    });
    const due = await this.prisma.sheetsPushLog.findMany({
      where: {
        emailStatus: 'PENDING',
        emailTo: null,
        contactFormUrl: { not: null },
        emailDueAt: { lte: now },
      },
      orderBy: { emailDueAt: 'asc' },
      take: 5,
      include: { connection: { select: { googleEmail: true } } },
    });
    for (const log of due) {
      if (!log.emailTemplate || !log.connection.googleEmail) {
        await this.prisma.sheetsPushLog.updateMany({
          where: { id: log.id, emailStatus: 'PENDING' },
          data: {
            emailStatus: 'MANUAL',
            emailError: 'A follow-up template and sender email are required.',
          },
        });
        continue;
      }
      const message = renderTemplate(loadTemplate(log.emailTemplate), templateVars(log));
      const leaseToken = randomUUID();
      const result = await this.prisma.sheetsPushLog.updateMany({
        where: { id: log.id, emailStatus: 'PENDING' },
        data: {
          emailStatus: 'FORM_PREPARING',
          formLeaseToken: leaseToken,
          emailAttempts: { increment: 1 },
        },
      });
      if (!result.count) continue;
      const signature =
        message.body.match(/(?:Best|Regards|Thanks|Sincerely),?\s*\n([^\n]+)\s*$/i)?.[1]?.trim() ??
        '';
      return [
        {
          id: log.id,
          leaseToken,
          url: log.contactFormUrl!,
          ...message,
          sender: { name: signature, email: log.connection.googleEmail, phone: log.callerE164 },
        },
      ];
    }
    return [];
  }

  /** Must succeed immediately before clicking Submit. Never replay a claimed submission. */
  async arm(id: string, leaseToken: string): Promise<{ armed: boolean }> {
    const result = await this.prisma.sheetsPushLog.updateMany({
      where: { id, formLeaseToken: leaseToken, emailStatus: 'FORM_PREPARING' },
      data: { emailStatus: 'FORM_SENDING' },
    });
    return { armed: result.count === 1 };
  }

  async complete(
    id: string,
    leaseToken: string,
    status: 'SENT' | 'MANUAL' | 'FAILED',
    notes?: string,
  ) {
    const result = await this.prisma.sheetsPushLog.updateMany({
      where: {
        id,
        formLeaseToken: leaseToken,
        emailStatus:
          status === 'SENT' ? 'FORM_SENDING' : { in: ['FORM_PREPARING', 'FORM_SENDING'] },
      },
      data: {
        emailStatus: status,
        emailSentAt: status === 'SENT' ? new Date() : null,
        emailError: status === 'SENT' ? null : (notes ?? 'Form needs review.').slice(0, 500),
      },
    });
    return { saved: result.count === 1 };
  }
}
