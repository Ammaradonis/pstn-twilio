import { randomUUID } from 'crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import {
  normalizeDialablePhoneNumber,
  type ContactDto,
  type ContactImportInput,
  type ContactImportResultDto,
  type ContactUpsertInput,
} from '@pstn-twilio/shared';

import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';

import { mapContact, type VoiceActor } from './voice-app.context';

const PHONE_LABELS = new Set(['mobile', 'home', 'work', 'other']);
const CONTACT_INCLUDE = { phones: { orderBy: { e164: 'asc' as const } } };

type PhoneInput = { number: string; label?: string };

@Injectable()
export class VoiceAppContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
  ) {}

  async list(userId: string): Promise<ContactDto[]> {
    const rows = await this.prisma.contact.findMany({
      where: { userId },
      include: CONTACT_INCLUDE,
      orderBy: { name: 'asc' },
    });
    return rows.map(mapContact);
  }

  async get(userId: string, id: string): Promise<ContactDto> {
    const row = await this.prisma.contact.findFirst({
      where: { id, userId },
      include: CONTACT_INCLUDE,
    });
    if (!row) throw new NotFoundException('Contact not found');
    return mapContact(row);
  }

  async create(actor: VoiceActor, input: ContactUpsertInput): Promise<ContactDto> {
    const phones = normalizePhones(input.phones);
    const row = await this.prisma.contact.create({
      data: {
        userId: actor.userId,
        name: input.name,
        company: input.company ?? null,
        email: input.email ?? null,
        notes: input.notes ?? null,
        starred: input.starred ?? false,
        source: 'manual',
        phones: { create: phones.map((p) => ({ ...p, userId: actor.userId })) },
      },
      include: CONTACT_INCLUDE,
    });
    this.realtime.voiceAppSync(actor.userId, ['contacts']);
    return mapContact(row);
  }

  async update(actor: VoiceActor, id: string, input: ContactUpsertInput): Promise<ContactDto> {
    await this.get(actor.userId, id);
    const phones = normalizePhones(input.phones);
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.contactPhone.deleteMany({ where: { contactId: id } });
      return tx.contact.update({
        where: { id },
        data: {
          name: input.name,
          company: input.company ?? null,
          email: input.email ?? null,
          notes: input.notes ?? null,
          ...(input.starred !== undefined ? { starred: input.starred } : {}),
          phones: { create: phones.map((p) => ({ ...p, userId: actor.userId })) },
        },
        include: CONTACT_INCLUDE,
      });
    });
    this.realtime.voiceAppSync(actor.userId, ['contacts']);
    return mapContact(row);
  }

  async remove(actor: VoiceActor, id: string): Promise<void> {
    await this.get(actor.userId, id);
    await this.prisma.contact.delete({ where: { id } });
    this.realtime.voiceAppSync(actor.userId, ['contacts']);
  }

  /**
   * Adds contacts picked from the phone or read from a .vcf file. A contact
   * that shares a phone number (or the exact name) with an existing one is
   * merged into it instead of duplicated.
   */
  async import(actor: VoiceActor, input: ContactImportInput): Promise<ContactImportResultDto> {
    const existing = await this.prisma.contact.findMany({
      where: { userId: actor.userId },
      include: { phones: true },
    });
    type Working = {
      id: string;
      isNew: boolean;
      changed: boolean;
      name: string;
      company: string | null;
      email: string | null;
      phones: Map<string, string | null>;
    };
    const byPhone = new Map<string, Working>();
    const byName = new Map<string, Working>();
    const all: Working[] = existing.map((row) => ({
      id: row.id,
      isNew: false,
      changed: false,
      name: row.name,
      company: row.company,
      email: row.email,
      phones: new Map(row.phones.map((p) => [p.e164, p.label])),
    }));
    for (const contact of all) {
      byName.set(contact.name.toLowerCase(), contact);
      for (const e164 of contact.phones.keys()) byPhone.set(e164, contact);
    }

    let skipped = 0;
    const createdIds = new Set<string>();
    const updatedIds = new Set<string>();
    for (const item of input.contacts) {
      const phones = normalizePhones(item.phones);
      const name = item.name.trim() || phones[0]?.e164 || '';
      if (!name || phones.length === 0) {
        skipped += 1;
        continue;
      }
      const match =
        phones.map((p) => byPhone.get(p.e164)).find(Boolean) ?? byName.get(name.toLowerCase());
      if (match) {
        let changed = false;
        for (const phone of phones) {
          if (!match.phones.has(phone.e164)) {
            match.phones.set(phone.e164, phone.label);
            byPhone.set(phone.e164, match);
            changed = true;
          }
        }
        if (!match.email && item.email) {
          match.email = item.email;
          changed = true;
        }
        if (!match.company && item.company) {
          match.company = item.company;
          changed = true;
        }
        if (changed) {
          match.changed = true;
          if (!match.isNew) updatedIds.add(match.id);
        } else if (!match.isNew) {
          skipped += 1;
        }
        continue;
      }
      const contact: Working = {
        id: randomUUID(),
        isNew: true,
        changed: true,
        name,
        company: item.company || null,
        email: item.email || null,
        phones: new Map(phones.map((p) => [p.e164, p.label])),
      };
      all.push(contact);
      createdIds.add(contact.id);
      byName.set(name.toLowerCase(), contact);
      for (const e164 of contact.phones.keys()) byPhone.set(e164, contact);
    }

    const created = all.filter((c) => c.isNew);
    const updated = all.filter((c) => !c.isNew && c.changed);
    const existingPhones = new Map(
      existing.map((row) => [row.id, new Set(row.phones.map((p) => p.e164))]),
    );
    await this.prisma.$transaction([
      this.prisma.contact.createMany({
        data: created.map((c) => ({
          id: c.id,
          userId: actor.userId,
          name: c.name,
          company: c.company,
          email: c.email,
          source: input.source,
        })),
      }),
      this.prisma.contactPhone.createMany({
        data: [
          ...created.flatMap((c) =>
            [...c.phones].map(([e164, label]) => ({
              contactId: c.id,
              userId: actor.userId,
              e164,
              label,
            })),
          ),
          ...updated.flatMap((c) =>
            [...c.phones]
              .filter(([e164]) => !existingPhones.get(c.id)?.has(e164))
              .map(([e164, label]) => ({ contactId: c.id, userId: actor.userId, e164, label })),
          ),
        ],
        skipDuplicates: true,
      }),
      ...updated.map((c) =>
        this.prisma.contact.update({
          where: { id: c.id },
          data: { email: c.email, company: c.company },
        }),
      ),
    ]);

    if (createdIds.size > 0 || updatedIds.size > 0) {
      this.realtime.voiceAppSync(actor.userId, ['contacts']);
    }
    return { created: createdIds.size, updated: updatedIds.size, skipped };
  }
}

function normalizePhones(phones: PhoneInput[]): Array<{ e164: string; label: string | null }> {
  const seen = new Set<string>();
  const result: Array<{ e164: string; label: string | null }> = [];
  for (const phone of phones) {
    const e164 = normalizeDialablePhoneNumber(phone.number);
    if (!e164 || seen.has(e164)) continue;
    seen.add(e164);
    const label = phone.label?.toLowerCase().trim();
    result.push({ e164, label: label && PHONE_LABELS.has(label) ? label : label ? 'other' : null });
  }
  return result;
}
