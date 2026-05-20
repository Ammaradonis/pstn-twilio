import { type SmsMessage } from '@prisma/client';
import type { PaginatedDto, SmsMessageDto } from '@pstn-twilio/shared';

export function mapMessage(row: SmsMessage): SmsMessageDto {
  return {
    id: row.id,
    phoneNumberId: row.phoneNumberId,
    twilioMessageSid: row.twilioMessageSid,
    direction: row.direction,
    from: row.fromE164,
    to: row.toE164,
    body: row.body ?? '',
    status: row.status,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    numMedia: row.numMedia,
    mediaUrls: extractMediaUrls(row.media),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function buildPaginated<T>(
  items: T[],
  cursorOf: (item: T) => string | null,
): PaginatedDto<T> {
  return {
    items,
    nextCursor: items.length > 0 ? cursorOf(items[items.length - 1]!) : null,
  };
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: createdAt.toISOString(), id }), 'utf8').toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string): { t: string; id: string } | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as { t?: unknown; id?: unknown };
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string') return null;
    return { t: parsed.t, id: parsed.id };
  } catch {
    return null;
  }
}

function extractMediaUrls(media: unknown): string[] {
  if (!media || !Array.isArray(media)) return [];
  return media.filter((u): u is string => typeof u === 'string');
}
