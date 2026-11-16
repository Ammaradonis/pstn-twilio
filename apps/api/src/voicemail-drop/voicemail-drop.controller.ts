import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  voicemailDropCallSchema,
  voicemailDropUploadSchema,
  type VoicemailDropCallInput,
  type VoicemailDropUploadInput,
} from '@pstn-twilio/shared';
import type { Request, Response } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod.pipe';

import { VoicemailDropService } from './voicemail-drop.service';

type ActorRequest = Request & {
  user: { id: string; email: string; role: UserRole };
};

@Controller('voicemail-drop')
@UseGuards(JwtAuthGuard)
export class VoicemailDropController {
  constructor(private readonly drops: VoicemailDropService) {}

  /** The saved message, or null before one is recorded. */
  @Get()
  get(@Req() req: ActorRequest) {
    return this.drops.get(req.user.id);
  }

  @Put()
  save(
    @Req() req: ActorRequest,
    @Body(new ZodValidationPipe(voicemailDropUploadSchema)) body: VoicemailDropUploadInput,
  ) {
    return this.drops.save(req.user.id, body);
  }

  @Delete()
  @HttpCode(204)
  async remove(@Req() req: ActorRequest): Promise<void> {
    await this.drops.remove(req.user.id);
  }

  @Get('audio')
  async audio(@Req() req: ActorRequest, @Res() res: Response): Promise<void> {
    const message = await this.drops.audio(req.user.id);
    res.setHeader('Content-Type', message.contentType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(message.audio);
  }

  /** Leaves the message on the live outbound call and ends the browser's side. */
  @Post('drop')
  @HttpCode(200)
  drop(
    @Req() req: ActorRequest,
    @Body(new ZodValidationPipe(voicemailDropCallSchema)) body: VoicemailDropCallInput,
  ) {
    return this.drops.drop({ userId: req.user.id, role: req.user.role }, body.callSid);
  }
}

/**
 * The message for Twilio <Play>. Twilio fetches media without a request
 * signature, so the unguessable token is the credential. Each recording gets
 * a new token, so the file behind a URL never changes.
 */
@Controller('webhooks/twilio/voicemail-drop')
export class VoicemailDropMediaController {
  constructor(private readonly drops: VoicemailDropService) {}

  @Get(':token')
  async media(@Param('token') token: string, @Res() res: Response): Promise<void> {
    if (!/^[A-Za-z0-9_-]{20,64}(\.wav)?$/.test(token)) throw new NotFoundException();
    const message = await this.drops.audioByToken(token);
    res.setHeader('Content-Type', message.contentType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(message.audio);
  }
}
