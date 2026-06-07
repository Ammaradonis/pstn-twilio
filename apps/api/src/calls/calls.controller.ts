import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { CallDirection, CallStatus, UserRole } from '@prisma/client';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ZodValidationPipe } from '../common/zod.pipe';

import { CallsService } from './calls.service';

const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  direction: z.nativeEnum(CallDirection).optional(),
  status: z.nativeEnum(CallStatus).optional(),
  since: z.string().datetime().optional(),
});

const lastDialQuerySchema = z.object({
  destination: z.string().min(1).max(256),
});

const voicemailListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const noteSchema = z.object({
  note: z.string().min(1).max(2000),
});

type ActorRequest = Request & {
  user: { id: string; email: string; role: UserRole };
};

function actorFromRequest(req: ActorRequest) {
  return {
    userId: req.user.id,
    role: req.user.role,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  };
}

@Controller()
@UseGuards(JwtAuthGuard)
export class CallsController {
  constructor(private readonly calls: CallsService) {}

  @Get('numbers/:numberId/calls')
  list(
    @Req() req: ActorRequest,
    @Param('numberId') numberId: string,
    @Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ) {
    return this.calls.list(actorFromRequest(req), numberId, query);
  }

  @Get('numbers/:numberId/calls/last-dial')
  findLastDial(
    @Req() req: ActorRequest,
    @Param('numberId') numberId: string,
    @Query(new ZodValidationPipe(lastDialQuerySchema))
    query: z.infer<typeof lastDialQuerySchema>,
  ) {
    return this.calls.findLastDial(actorFromRequest(req), numberId, query.destination);
  }

  @Get('numbers/:numberId/calls/:callId')
  getOne(
    @Req() req: ActorRequest,
    @Param('numberId') numberId: string,
    @Param('callId') callId: string,
  ) {
    return this.calls.getOne(actorFromRequest(req), numberId, callId);
  }

  @Get('voicemail')
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  voicemail(
    @Query(new ZodValidationPipe(voicemailListQuerySchema))
    query: z.infer<typeof voicemailListQuerySchema>,
  ) {
    return this.calls.listVoicemail(query);
  }

  @Post('calls/:callId/hangup')
  @HttpCode(200)
  hangup(@Req() req: ActorRequest, @Param('callId') callId: string) {
    return this.calls.hangup(actorFromRequest(req), callId);
  }

  @Post('calls/:callId/notes')
  @HttpCode(201)
  addNote(
    @Req() req: ActorRequest,
    @Param('callId') callId: string,
    @Body(new ZodValidationPipe(noteSchema)) body: z.infer<typeof noteSchema>,
  ) {
    return this.calls.addNote(actorFromRequest(req), callId, body.note);
  }

  @Get('numbers/:numberId/calls/:callId/recordings/:recordingId/media')
  async recordingMedia(
    @Req() req: ActorRequest,
    @Param('numberId') numberId: string,
    @Param('callId') callId: string,
    @Param('recordingId') recordingId: string,
    @Res() res: Response,
  ) {
    const media = await this.calls.getRecordingMedia(
      actorFromRequest(req),
      numberId,
      callId,
      recordingId,
    );
    res.setHeader('Content-Type', media.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${media.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(media.body);
  }

  @Get('voicemail/:recordingId/media')
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  async voicemailMedia(@Param('recordingId') recordingId: string, @Res() res: Response) {
    const media = await this.calls.getVoicemailMedia(recordingId);
    res.setHeader('Content-Type', media.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${media.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(media.body);
  }
}
