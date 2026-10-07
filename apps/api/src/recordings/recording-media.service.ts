import type { Readable } from 'stream';

import { Injectable, NotFoundException } from '@nestjs/common';
import type { CallRecording } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TwilioService } from '../twilio/twilio.service';

import { audioExtension, RecordingStorageService } from './recording-storage.service';

export interface RecordingMedia {
  stream: Readable;
  contentType: string;
  /** File extension without the dot, from the content type. */
  extension: string;
}

/**
 * Opens a recording's audio wherever it lives: our own storage once it has
 * been archived or uploaded there, otherwise Twilio.
 */
@Injectable()
export class RecordingMediaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly twilio: TwilioService,
    private readonly storage: RecordingStorageService,
  ) {}

  async open(
    recording: Pick<CallRecording, 'id' | 'storageKey' | 'twilioRecordingSid'>,
  ): Promise<RecordingMedia> {
    if (recording.storageKey) return this.fromStorage(recording.storageKey);
    if (!recording.twilioRecordingSid) {
      throw new NotFoundException('This recording has no audio file.');
    }
    try {
      return withExtension(await this.twilio.fetchRecordingMedia(recording.twilioRecordingSid));
    } catch (err) {
      // The archiver may have moved it to storage and deleted it from Twilio
      // after this row was read.
      const fresh = await this.prisma.callRecording.findUnique({
        where: { id: recording.id },
        select: { storageKey: true },
      });
      if (fresh?.storageKey) return this.fromStorage(fresh.storageKey);
      throw err;
    }
  }

  private async fromStorage(key: string): Promise<RecordingMedia> {
    return withExtension(await this.storage.get(key));
  }
}

function withExtension(media: { stream: Readable; contentType: string }): RecordingMedia {
  return { ...media, extension: audioExtension(media.contentType) };
}
