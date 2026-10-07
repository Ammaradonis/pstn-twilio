import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { Request } from 'express';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod.pipe';

import { readAll } from './recording-storage.service';
import { RecordingsService } from './recordings.service';

// A one-hour call (the Dial time limit) at the browser's ~32 kbps is ~15 MB.
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const UPLOAD_CONTENT_TYPES = new Set(['audio/webm', 'audio/ogg', 'audio/mp4']);
const CALL_SID = z.string().regex(/^CA[0-9a-fA-F]{32}$/);

const browserUploadQuerySchema = z.object({
  uploadId: z.string().uuid(),
  callSid: CALL_SID,
  startedAt: z.string().datetime().optional(),
  durationSeconds: z.coerce
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60),
});

const twilioBackupSchema = z.object({ callSid: CALL_SID });

type ActorRequest = Request & {
  user: { id: string; email: string; role: UserRole };
};

@Controller('recordings')
@UseGuards(JwtAuthGuard)
export class RecordingsController {
  constructor(private readonly recordings: RecordingsService) {}

  /** The raw audio file of a call recorded in the browser. */
  @Post('browser')
  @HttpCode(201)
  async uploadBrowserRecording(
    @Req() req: ActorRequest,
    @Query(new ZodValidationPipe(browserUploadQuerySchema))
    query: z.infer<typeof browserUploadQuerySchema>,
  ) {
    const contentType = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (!UPLOAD_CONTENT_TYPES.has(contentType)) {
      throw new BadRequestException('Upload the recording as audio/webm, audio/ogg or audio/mp4.');
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('The recording is too large.');
    }
    let body: Buffer;
    try {
      body = await readAll(req, MAX_UPLOAD_BYTES);
    } catch {
      throw new BadRequestException('The recording is too large or the upload was interrupted.');
    }
    return this.recordings.saveBrowserRecording(
      { userId: req.user.id, role: req.user.role },
      query,
      body,
      contentType,
    );
  }

  @Post('twilio-backup')
  @HttpCode(201)
  startTwilioBackup(
    @Req() req: ActorRequest,
    @Body(new ZodValidationPipe(twilioBackupSchema)) body: z.infer<typeof twilioBackupSchema>,
  ) {
    return this.recordings.startTwilioBackup(
      { userId: req.user.id, role: req.user.role },
      body.callSid,
    );
  }
}
