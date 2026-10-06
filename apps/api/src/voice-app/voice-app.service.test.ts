/**
 * callKind decides what a row in the call log says it was. The order matters:
 * a call the user declined or blocked is a decision they made, so it has to win
 * over how the call happened to end (a declined caller still reaches voicemail,
 * and a blocked caller still gets a Call row).
 */

import { CallDirection, CallStatus, RecordingStatus, type CallRecording } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { callKind, mapCallLogItem } from './voice-app.service';

type Row = Parameters<typeof callKind>[0];
type Recording = Partial<CallRecording>;

function call(overrides: Record<string, unknown> = {}, recordings: Recording[] = []): Row {
  return {
    id: 'c1',
    phoneNumberId: 'pn1',
    twilioCallSid: 'CA1',
    parentCallSid: null,
    direction: CallDirection.INBOUND,
    fromE164: '+14155550100',
    toE164: '+18776524532',
    browserIdentity: null,
    selectedCallerId: null,
    destinationE164: null,
    status: CallStatus.COMPLETED,
    durationSeconds: 0,
    price: null,
    priceUnit: null,
    rawPayload: null,
    startedAt: new Date('2026-10-05T17:04:03Z'),
    answeredAt: null,
    endedAt: new Date('2026-10-05T17:04:10Z'),
    handledBy: null,
    createdAt: new Date('2026-10-05T17:04:03Z'),
    updatedAt: new Date('2026-10-05T17:04:10Z'),
    ...overrides,
    recordings: recordings as CallRecording[],
  } as Row;
}

function voicemailRecording(overrides: Recording = {}): Recording {
  return {
    id: 'r1',
    callId: 'c1',
    twilioCallSid: 'CA1',
    twilioRecordingSid: 'RE1',
    recordingUrl: null,
    status: RecordingStatus.COMPLETED,
    durationSeconds: 12,
    channels: null,
    source: 'voicemail',
    track: null,
    rawPayload: null,
    startedAt: null,
    transcript: null,
    transcriptStatus: null,
    heardAt: null,
    createdAt: new Date('2026-10-05T17:04:12Z'),
    updatedAt: new Date('2026-10-05T17:04:12Z'),
    ...overrides,
  };
}

describe('callKind', () => {
  it('reads an unanswered inbound call with no voicemail as missed', () => {
    expect(callKind(call())).toBe('missed');
  });

  it('reads an inbound call that was picked up as answered', () => {
    expect(callKind(call({ answeredAt: new Date('2026-10-05T17:04:04Z') }))).toBe('answered');
  });

  it('reads a call with a playable voicemail as voicemail', () => {
    expect(callKind(call({}, [voicemailRecording()]))).toBe('voicemail');
  });

  it('reads a call placed by the user as outgoing', () => {
    expect(
      callKind(
        call({
          direction: CallDirection.OUTBOUND,
          fromE164: '+18776524532',
          toE164: '+14155550100',
          destinationE164: '+14155550100',
        }),
      ),
    ).toBe('outgoing');
  });

  it('keeps a declined call marked declined even though the caller left a voicemail', () => {
    expect(callKind(call({ handledBy: 'declined' }, [voicemailRecording()]))).toBe('declined');
  });

  it('keeps a declined call marked declined when nothing was recorded', () => {
    expect(callKind(call({ handledBy: 'declined' }))).toBe('declined');
  });

  it('reads a blocked caller as blocked', () => {
    expect(callKind(call({ handledBy: 'blocked' }))).toBe('blocked');
  });

  it('lets an answered call outrank a voicemail left later', () => {
    expect(
      callKind(call({ answeredAt: new Date('2026-10-05T17:04:04Z') }, [voicemailRecording()])),
    ).toBe('answered');
  });

  it('ignores a voicemail recording that is too short to play', () => {
    expect(callKind(call({}, [voicemailRecording({ durationSeconds: 0 })]))).toBe('missed');
  });
});

describe('mapCallLogItem', () => {
  it('reports the caller as the counterpart of an inbound call', () => {
    const item = mapCallLogItem(call());
    expect(item.counterpart).toBe('+14155550100');
    expect(item.kind).toBe('missed');
    expect(item.startedAt).toBe('2026-10-05T17:04:03.000Z');
    expect(item.voicemail).toBeNull();
  });

  it('reports the dialled number as the counterpart of an outbound call', () => {
    const item = mapCallLogItem(
      call({
        direction: CallDirection.OUTBOUND,
        toE164: '+14155550100',
        destinationE164: '+14155550999',
      }),
    );
    expect(item.counterpart).toBe('+14155550999');
  });

  it('attaches the playable voicemail to the item', () => {
    const item = mapCallLogItem(call({}, [voicemailRecording({ transcript: 'Call me back' })]));
    expect(item.kind).toBe('voicemail');
    expect(item.voicemail?.transcript).toBe('Call me back');
    expect(item.voicemail?.durationSeconds).toBe(12);
  });
});
