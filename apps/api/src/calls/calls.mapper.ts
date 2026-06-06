import type { Call, CallRecording } from '@prisma/client';
import type { CallDto, CallRecordingDto } from '@pstn-twilio/shared';

type CallWithRecordings = Call & { recordings?: CallRecording[] };

export function mapCall(row: CallWithRecordings): CallDto {
  return {
    id: row.id,
    phoneNumberId: row.phoneNumberId,
    twilioCallSid: row.twilioCallSid,
    direction: row.direction,
    from: row.fromE164,
    to: row.toE164,
    selectedCallerId: row.selectedCallerId,
    destination: row.destinationE164,
    status: row.status,
    durationSeconds: row.durationSeconds,
    startedAt: (row.startedAt ?? row.createdAt).toISOString(),
    answeredAt: row.answeredAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    recordings: (row.recordings ?? []).map(mapCallRecording),
  };
}

export function mapCallRecording(row: CallRecording): CallRecordingDto {
  return {
    id: row.id,
    twilioCallSid: row.twilioCallSid,
    twilioRecordingSid: row.twilioRecordingSid,
    recordingUrl: row.recordingUrl,
    status: row.status,
    durationSeconds: row.durationSeconds,
    channels: row.channels,
    source: row.source,
    track: row.track,
    startedAt: row.startedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
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
