/**
 * Moves Twilio recordings into our own storage (Cloudflare R2), then deletes
 * them from Twilio so Twilio's storage never fills past its free allowance.
 *
 * A sweep every few minutes picks up completed recordings that have settled
 * for a while (the Dial page downloads a recording, and voicemail is
 * transcribed, right after Twilio finishes it). Each one is copied, checked
 * byte for byte, recorded on its row, and only then deleted from Twilio. A
 * failed copy is retried on later sweeps, up to MAX_ATTEMPTS; a failed delete
 * is retried until it succeeds. Rows are the schedule, so restarts and
 * deploys lose nothing.
 */

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RecordingStatus, type CallRecording } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { TwilioRecordingMediaError, TwilioService } from '../twilio/twilio.service';

import { readAll, RecordingStorageService } from './recording-storage.service';

const SWEEP_MS = 3 * 60_000;
const SETTLE_MS = 10 * 60_000;
const BATCH_SIZE = 10;
export const MAX_ARCHIVE_ATTEMPTS = 5;
const LOCK_KEY = 'recordings:archive-lock';
const LOCK_TTL_SECONDS = 10 * 60;

@Injectable()
export class RecordingArchiverService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RecordingArchiverService.name);
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly redis: RedisService,
    private readonly storage: RecordingStorageService,
  ) {}

  onModuleInit(): void {
    if (!this.storage.enabled) {
      this.logger.warn('R2 is not configured; recordings stay at Twilio.');
      return;
    }
    this.timer = setInterval(() => void this.sweep(), SWEEP_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** RECORDINGS_DELETE_FROM_TWILIO=false keeps Twilio's copy after archiving. */
  private get deleteFromTwilio(): boolean {
    return this.config.get<string>('RECORDINGS_DELETE_FROM_TWILIO') !== 'false';
  }

  async sweep(now = new Date()): Promise<void> {
    if (this.running || !this.storage.enabled) return;
    this.running = true;
    let locked = false;
    try {
      locked = await this.takeLock();
      if (!locked) return;
      const due = await this.prisma.callRecording.findMany({
        where: {
          status: RecordingStatus.COMPLETED,
          storedAt: null,
          twilioRecordingSid: { not: null },
          archiveAttempts: { lt: MAX_ARCHIVE_ATTEMPTS },
          updatedAt: { lt: new Date(now.getTime() - SETTLE_MS) },
        },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
      });
      // Every Twilio recording is archived, including the Twilio copy of a
      // call the browser also recorded: browser recordings under
      // MIN_BROWSER_RECORDING_SECONDS are never uploaded, so for a short call
      // this may be the only stored copy.
      for (const recording of due) await this.archive(recording);

      if (this.deleteFromTwilio) {
        const undeleted = await this.prisma.callRecording.findMany({
          where: {
            storedAt: { not: null },
            twilioDeletedAt: null,
            twilioRecordingSid: { not: null },
          },
          orderBy: { storedAt: 'asc' },
          take: BATCH_SIZE,
        });
        for (const recording of undeleted) await this.deleteTwilioCopy(recording);
      }
    } catch (err) {
      this.logger.error(`Recording archive sweep failed: ${(err as Error).message}`);
    } finally {
      if (locked) await this.releaseLock();
      this.running = false;
    }
  }

  async archive(recording: CallRecording): Promise<void> {
    const sid = recording.twilioRecordingSid;
    if (!sid) return;
    try {
      const media = await this.twilio.fetchRecordingMedia(sid);
      const body = await readAll(media.stream);
      if (body.length === 0) throw new Error('Twilio returned an empty recording');
      const contentType = media.contentType.split(';')[0]!.trim() || 'audio/mpeg';
      const key = this.storage.keyFor({
        twilioCallSid: recording.twilioCallSid,
        name: sid,
        contentType,
        at: recording.createdAt,
      });
      await this.storage.put(key, body, contentType);
      await this.prisma.callRecording.update({
        where: { id: recording.id },
        data: {
          storageKey: key,
          contentType,
          sizeBytes: body.length,
          storedAt: new Date(),
          archiveError: null,
        },
      });
    } catch (err) {
      // Twilio no longer has it (deleted by hand): there is nothing to copy.
      const gone = err instanceof TwilioRecordingMediaError && err.status === 404;
      const message = gone
        ? 'Twilio no longer has this recording.'
        : (err as Error).message || 'Archive failed';
      this.logger.warn(`Archiving recording ${sid} failed: ${message}`);
      await this.prisma.callRecording.update({
        where: { id: recording.id },
        data: {
          archiveAttempts: gone ? MAX_ARCHIVE_ATTEMPTS : { increment: 1 },
          archiveError: message.slice(0, 500),
        },
      });
      return;
    }
    if (this.deleteFromTwilio) await this.deleteTwilioCopy(recording);
  }

  private async deleteTwilioCopy(recording: CallRecording): Promise<void> {
    if (!recording.twilioRecordingSid) return;
    try {
      await this.twilio.deleteRecording(recording.twilioRecordingSid);
      await this.prisma.callRecording.update({
        where: { id: recording.id },
        data: { twilioDeletedAt: new Date() },
      });
    } catch (err) {
      this.logger.warn(
        `Deleting recording ${recording.twilioRecordingSid} from Twilio failed: ${(err as Error).message}`,
      );
    }
  }

  // Keeps two API machines from copying the same recording at once. Without
  // Redis the sweep still runs; a duplicate copy is harmless.
  private async takeLock(): Promise<boolean> {
    try {
      const taken = await this.redis.client.set(LOCK_KEY, '1', 'EX', LOCK_TTL_SECONDS, 'NX');
      return taken === 'OK';
    } catch {
      return true;
    }
  }

  private async releaseLock(): Promise<void> {
    try {
      await this.redis.client.del(LOCK_KEY);
    } catch {
      /* expires on its own */
    }
  }
}
