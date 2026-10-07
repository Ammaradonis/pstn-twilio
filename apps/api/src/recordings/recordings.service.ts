import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Call, CallStatus, RecordingStatus, UserRole } from '@prisma/client';
import type { CallRecordingDto } from '@pstn-twilio/shared';

import { mapCall, mapCallRecording } from '../calls/calls.mapper';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TwilioService } from '../twilio/twilio.service';

import { RecordingStorageService } from './recording-storage.service';

interface ActorContext {
  userId: string;
  role: UserRole;
}

export interface BrowserRecordingInput {
  /** Chosen by the browser, so a retried upload is recognized. */
  uploadId: string;
  callSid: string;
  startedAt?: string;
  durationSeconds: number;
}

/**
 * Browser recordings shorter than this are not stored (the browser keeps them
 * on disk only). Twilio recordings are always archived, whatever their length.
 */
export const MIN_BROWSER_RECORDING_SECONDS = 90;

const ENDED_STATUSES: CallStatus[] = [
  CallStatus.COMPLETED,
  CallStatus.BUSY,
  CallStatus.FAILED,
  CallStatus.NO_ANSWER,
  CallStatus.CANCELED,
];

@Injectable()
export class RecordingsService {
  private readonly logger = new Logger(RecordingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly realtime: RealtimeService,
    private readonly storage: RecordingStorageService,
  ) {}

  /** Stores a call recorded in the browser and lists it with the call. */
  async saveBrowserRecording(
    actor: ActorContext,
    input: BrowserRecordingInput,
    body: Buffer,
    contentType: string,
  ): Promise<CallRecordingDto> {
    if (!this.storage.enabled) {
      throw new ServiceUnavailableException(
        'Recording storage is not set up yet. The recording stays in this browser and uploads later.',
      );
    }
    if (body.length === 0) throw new BadRequestException('The recording is empty.');
    if (input.durationSeconds < MIN_BROWSER_RECORDING_SECONDS) {
      throw new BadRequestException(
        `Browser recordings under ${MIN_BROWSER_RECORDING_SECONDS} seconds are not stored.`,
      );
    }

    const call = await this.ownedCall(actor, input.callSid);
    const callSid = call.twilioCallSid ?? input.callSid;
    const existing = await this.prisma.callRecording.findUnique({ where: { id: input.uploadId } });
    if (existing) {
      if (existing.callId !== call.id) {
        throw new ConflictException('This upload belongs to another call.');
      }
      return mapCallRecording(existing);
    }

    const startedAt = input.startedAt ? new Date(input.startedAt) : new Date();
    const key = this.storage.keyFor({
      twilioCallSid: callSid,
      name: input.uploadId,
      contentType,
      at: startedAt,
    });
    await this.storage.put(key, body, contentType);

    let recording;
    try {
      recording = await this.prisma.callRecording.create({
        data: {
          id: input.uploadId,
          callId: call.id,
          twilioCallSid: callSid,
          status: RecordingStatus.COMPLETED,
          durationSeconds: input.durationSeconds,
          channels: 2,
          source: 'browser',
          track: 'both',
          startedAt,
          storageKey: key,
          contentType,
          sizeBytes: body.length,
          storedAt: new Date(),
        },
      });
    } catch (err) {
      // Two tabs uploaded the same recording at once; the other one won.
      const raced = await this.prisma.callRecording.findUnique({ where: { id: input.uploadId } });
      if (raced?.callId !== call.id) throw err;
      return mapCallRecording(raced);
    }

    const updated = await this.prisma.call.findUnique({
      where: { id: call.id },
      include: { recordings: { orderBy: { createdAt: 'desc' } } },
    });
    if (updated) {
      this.realtime.callStatusUpdated({ numberId: updated.phoneNumberId, call: mapCall(updated) });
    }
    return mapCallRecording(recording);
  }

  /**
   * Has Twilio record the rest of a call that is up, as a backup copy of the
   * browser recording. Does nothing when Twilio is already recording it.
   */
  async startTwilioBackup(
    actor: ActorContext,
    callSid: string,
  ): Promise<{ recordingSid: string | null; alreadyRecording: boolean }> {
    const call = await this.ownedCall(actor, callSid);
    if (ENDED_STATUSES.includes(call.status)) {
      throw new BadRequestException('The call has already ended.');
    }
    const parentSid = call.twilioCallSid ?? callSid;
    const recording = await this.prisma.callRecording.findFirst({
      where: {
        twilioCallSid: parentSid,
        twilioRecordingSid: { not: null },
        status: RecordingStatus.IN_PROGRESS,
      },
    });
    if (recording) return { recordingSid: recording.twilioRecordingSid, alreadyRecording: true };

    try {
      const recordingSid = await this.twilio.startCallRecording(parentSid);
      return { recordingSid, alreadyRecording: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Twilio could not start recording';
      this.logger.warn(`Backup recording for ${callSid} failed: ${message}`);
      throw new BadRequestException({ statusCode: 400, error: 'TwilioRecordingError', message });
    }
  }

  private async ownedCall(actor: ActorContext, callSid: string): Promise<Call> {
    const call =
      (await this.prisma.call.findUnique({ where: { twilioCallSid: callSid } })) ??
      (await this.parentCall(callSid));
    if (!call) throw new NotFoundException('This call is not in the call log yet.');
    if (actor.role === UserRole.OWNER) return call;
    const number = call.phoneNumberId
      ? await this.prisma.phoneNumber.findUnique({ where: { id: call.phoneNumberId } })
      : null;
    if (number?.userId !== actor.userId) {
      throw new ForbiddenException('You do not own this call.');
    }
    return call;
  }

  // A browser that answered an incoming call knows only its own leg; the call
  // log holds the inbound call that leg belongs to.
  private async parentCall(legSid: string): Promise<Call | null> {
    try {
      const leg = await this.twilio.client.calls(legSid).fetch();
      if (!leg.parentCallSid) return null;
      return await this.prisma.call.findUnique({ where: { twilioCallSid: leg.parentCallSid } });
    } catch {
      return null;
    }
  }
}
