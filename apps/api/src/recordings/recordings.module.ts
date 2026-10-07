import { Global, Module } from '@nestjs/common';

import { RecordingArchiverService } from './recording-archiver.service';
import { RecordingMediaService } from './recording-media.service';
import { RecordingStorageService } from './recording-storage.service';
import { RecordingsController } from './recordings.controller';
import { RecordingsService } from './recordings.service';

/**
 * Call recordings in our own storage: Twilio recordings archived there,
 * browser recordings uploaded there, and playback from wherever a file lives.
 */
@Global()
@Module({
  controllers: [RecordingsController],
  providers: [
    RecordingStorageService,
    RecordingMediaService,
    RecordingArchiverService,
    RecordingsService,
  ],
  exports: [RecordingMediaService, RecordingStorageService],
})
export class RecordingsModule {}
