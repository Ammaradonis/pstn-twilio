import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  VoiceDeviceDto,
  VoiceDeviceUpsertInput,
  VoicePushSubscriptionInput,
} from '@pstn-twilio/shared';

import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

import type { VoiceActor } from './voice-app.context';

// The app checks in every minute while it is open on screen.
const ONLINE_WINDOW_MS = 3 * 60_000;

@Injectable()
export class VoiceAppDevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(userId: string): Promise<VoiceDeviceDto[]> {
    const rows = await this.prisma.userDevice.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
    });
    const now = Date.now();
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      platform: row.platform,
      lastSeenAt: row.lastSeenAt.toISOString(),
      online: now - row.lastSeenAt.getTime() < ONLINE_WINDOW_MS,
      notifications: Boolean(row.pushEndpoint),
    }));
  }

  /** Registers this device or records that it is still open. */
  async checkIn(actor: VoiceActor, id: string, input: VoiceDeviceUpsertInput): Promise<void> {
    const existing = await this.prisma.userDevice.findUnique({ where: { id } });
    if (existing && existing.userId !== actor.userId) {
      throw new ConflictException('Device id belongs to another account');
    }
    await this.prisma.userDevice.upsert({
      where: { id },
      update: {
        lastSeenAt: new Date(),
        userAgent: actor.userAgent ?? existing?.userAgent ?? null,
        platform: input.platform ?? existing?.platform ?? null,
      },
      create: {
        id,
        userId: actor.userId,
        name: input.name,
        platform: input.platform ?? null,
        userAgent: actor.userAgent ?? null,
      },
    });
    if (!existing) this.realtime.voiceAppSync(actor.userId, ['devices']);
  }

  async rename(actor: VoiceActor, id: string, name: string): Promise<void> {
    await this.own(actor.userId, id);
    await this.prisma.userDevice.update({ where: { id }, data: { name } });
    this.realtime.voiceAppSync(actor.userId, ['devices']);
  }

  async remove(actor: VoiceActor, id: string): Promise<void> {
    await this.own(actor.userId, id);
    await this.prisma.userDevice.delete({ where: { id } });
    this.realtime.voiceAppSync(actor.userId, ['devices']);
  }

  async subscribe(actor: VoiceActor, id: string, input: VoicePushSubscriptionInput): Promise<void> {
    await this.own(actor.userId, id);
    await this.prisma.$transaction([
      // The same browser re-registered under a new device id.
      this.prisma.userDevice.updateMany({
        where: { pushEndpoint: input.endpoint, id: { not: id } },
        data: { pushEndpoint: null, pushP256dh: null, pushAuth: null },
      }),
      this.prisma.userDevice.update({
        where: { id },
        data: {
          pushEndpoint: input.endpoint,
          pushP256dh: input.keys.p256dh,
          pushAuth: input.keys.auth,
          pushUpdatedAt: new Date(),
        },
      }),
    ]);
    this.realtime.voiceAppSync(actor.userId, ['devices']);
  }

  async unsubscribe(actor: VoiceActor, id: string): Promise<void> {
    await this.own(actor.userId, id);
    await this.prisma.userDevice.update({
      where: { id },
      data: { pushEndpoint: null, pushP256dh: null, pushAuth: null, pushUpdatedAt: new Date() },
    });
    this.realtime.voiceAppSync(actor.userId, ['devices']);
  }

  private async own(userId: string, id: string) {
    const row = await this.prisma.userDevice.findUnique({ where: { id } });
    if (!row || row.userId !== userId) throw new NotFoundException('Device not found');
    return row;
  }
}
