import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PhoneNumber, UserRole, VoiceSettings } from '@prisma/client';
import type {
  BlockedNumberDto,
  ContactDto,
  ContactSource,
  ForwardingNumberDto,
  ForwardingVerifyStatus,
  VoiceAppNumberDto,
  VoiceGreetingMode,
  VoiceSettingsDto,
} from '@pstn-twilio/shared';
import type { Request } from 'express';

import { PrismaService } from '../prisma/prisma.service';

export interface VoiceActor {
  userId: string;
  email: string;
  role: UserRole;
  ipAddress?: string;
  userAgent?: string;
}

export type VoiceActorRequest = Request & {
  user: { id: string; email: string; role: UserRole; experience?: string };
};

export function voiceActor(req: VoiceActorRequest): VoiceActor {
  return {
    userId: req.user.id,
    email: req.user.email,
    role: req.user.role,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  };
}

/** Voice app endpoints are only for users who sign in to the voice app. */
@Injectable()
export class VoiceExperienceGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<VoiceActorRequest>();
    if (req.user?.experience !== 'voice') {
      throw new ForbiddenException('This account does not use the voice app');
    }
    return true;
  }
}

// Whether a user signs in to the voice app rarely changes; avoid a DB read on
// every incoming call and text.
const EXPERIENCE_TTL_MS = 30_000;

/** Lookups shared by the voice app's services. */
@Injectable()
export class VoiceAppContext {
  private readonly experiences = new Map<string, { at: number; voice: boolean }>();

  constructor(private readonly prisma: PrismaService) {}

  async isVoiceUser(userId: string | null | undefined): Promise<boolean> {
    if (!userId) return false;
    const cached = this.experiences.get(userId);
    if (cached && Date.now() - cached.at < EXPERIENCE_TTL_MS) return cached.voice;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { experience: true, disabledAt: true },
    });
    const voice = user?.experience === 'voice' && !user.disabledAt;
    this.experiences.set(userId, { at: Date.now(), voice });
    return voice;
  }

  async settings(userId: string): Promise<VoiceSettings> {
    const existing = await this.prisma.voiceSettings.findUnique({ where: { userId } });
    if (existing) return existing;
    return this.prisma.voiceSettings.upsert({
      where: { userId },
      update: {},
      create: { userId },
    });
  }

  /** The user's active numbers, voice-capable first. */
  async numbers(userId: string): Promise<PhoneNumber[]> {
    const rows = await this.prisma.phoneNumber.findMany({
      where: { userId, active: true, releasedAt: null },
      orderBy: { purchasedAt: 'asc' },
    });
    return rows.sort((a, b) => Number(b.capabilitiesVoice) - Number(a.capabilitiesVoice));
  }

  async numberIds(userId: string): Promise<string[]> {
    return (await this.numbers(userId)).map((n) => n.id);
  }

  async primaryNumber(userId: string, capability: 'voice' | 'sms'): Promise<PhoneNumber> {
    const numbers = await this.numbers(userId);
    const number = numbers.find((n) =>
      capability === 'voice' ? n.capabilitiesVoice : n.capabilitiesSms,
    );
    if (!number) {
      throw new NotFoundException(
        capability === 'voice'
          ? 'Your account has no number that can make calls.'
          : 'Your account has no number that can send texts.',
      );
    }
    return number;
  }

  async isBlocked(userId: string, e164: string | undefined): Promise<boolean> {
    if (!e164) return false;
    const row = await this.prisma.blockedNumber.findUnique({
      where: { userId_e164: { userId, e164 } },
      select: { id: true },
    });
    return Boolean(row);
  }

  async contactName(userId: string, e164: string | undefined): Promise<string | null> {
    if (!e164) return null;
    const phone = await this.prisma.contactPhone.findFirst({
      where: { userId, e164 },
      select: { contact: { select: { name: true } } },
    });
    return phone?.contact.name ?? null;
  }
}

export function doNotDisturbActive(settings: VoiceSettings, now = new Date()): boolean {
  if (!settings.doNotDisturb) return false;
  return !settings.doNotDisturbUntil || settings.doNotDisturbUntil > now;
}

export function mapVoiceNumber(row: PhoneNumber): VoiceAppNumberDto {
  return {
    id: row.id,
    e164: row.phoneNumberE164,
    friendlyName: row.friendlyName ?? row.phoneNumberE164,
    voice: row.capabilitiesVoice,
    sms: row.capabilitiesSms,
  };
}

export function mapVoiceSettings(
  row: VoiceSettings,
  greeting: { durationMs: number; updatedAt: Date } | null,
): VoiceSettingsDto {
  return {
    ringDevices: row.ringDevices,
    screenCalls: row.screenCalls,
    ringSeconds: row.ringSeconds,
    doNotDisturb: doNotDisturbActive(row),
    doNotDisturbUntil: row.doNotDisturb ? (row.doNotDisturbUntil?.toISOString() ?? null) : null,
    voicemailEnabled: row.voicemailEnabled,
    voicemailTranscribe: row.voicemailTranscribe,
    greetingMode: row.greetingMode as VoiceGreetingMode,
    greetingText: row.greetingText,
    recordedGreeting: greeting
      ? { durationMs: greeting.durationMs, updatedAt: greeting.updatedAt.toISOString() }
      : null,
  };
}

export function mapForwarding(row: {
  id: string;
  e164: string;
  label: string;
  enabled: boolean;
  verifiedAt: Date | null;
  verifyStatus: string | null;
  createdAt: Date;
}): ForwardingNumberDto {
  return {
    id: row.id,
    e164: row.e164,
    label: row.label,
    enabled: row.enabled,
    verified: Boolean(row.verifiedAt),
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    verifyStatus: (row.verifyStatus as ForwardingVerifyStatus | null) ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mapBlocked(row: { id: string; e164: string; createdAt: Date }): BlockedNumberDto {
  return { id: row.id, e164: row.e164, createdAt: row.createdAt.toISOString() };
}

export function mapContact(row: {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  notes: string | null;
  starred: boolean;
  source: string;
  createdAt: Date;
  updatedAt: Date;
  phones: Array<{ e164: string; label: string | null }>;
}): ContactDto {
  return {
    id: row.id,
    name: row.name,
    company: row.company,
    email: row.email,
    notes: row.notes,
    starred: row.starred,
    source: row.source as ContactSource,
    phones: row.phones.map((p) => ({ e164: p.e164, label: p.label })),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// Speak a phone number digit by digit ("4 1 5, 5 5 5, …") so Twilio's voice
// doesn't read it as one large number.
export function spokenNumber(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length === 10) {
    return [national.slice(0, 3), national.slice(3, 6), national.slice(6)]
      .map((group) => group.split('').join(' '))
      .join(', ');
  }
  return national.split('').join(' ');
}
