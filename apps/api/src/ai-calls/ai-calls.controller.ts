import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import {
  aiInboundModeSchema,
  aiCallKeypadSchema,
  startAiCallSchema,
  type AiCallKeypadInput,
  type AiInboundMode,
  type StartAiCallInput,
} from '@pstn-twilio/shared';
import type { Request, Response } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ZodValidationPipe } from '../common/zod.pipe';

import { AiCallsService } from './ai-calls.service';
import { GoogleCalendarService } from './google-calendar.service';
import { InboundCallsService } from './inbound-calls.service';

type ActorRequest = Request & { user: { id: string; email: string; role: UserRole } };

function actorFromRequest(req: ActorRequest) {
  return {
    userId: req.user.id,
    role: req.user.role,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
  };
}

@Controller('ai-calls')
@UseGuards(JwtAuthGuard)
export class AiCallsController {
  constructor(
    private readonly aiCalls: AiCallsService,
    private readonly inbound: InboundCallsService,
  ) {}

  @Get('config')
  config(@Req() req: ActorRequest) {
    return this.aiCalls.config(req.user.id);
  }

  @Get()
  list(@Req() req: ActorRequest, @Query('limit') limit?: string) {
    return this.aiCalls.list(req.user.id, limit ? Number.parseInt(limit, 10) || 20 : 20);
  }

  @Get('inbound')
  inboundStatus() {
    return this.inbound.status();
  }

  @Put('inbound')
  @UseGuards(RolesGuard)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  setInboundMode(
    @Req() req: ActorRequest,
    @Body(new ZodValidationPipe(aiInboundModeSchema)) body: { mode: AiInboundMode },
  ) {
    return this.inbound.setMode(actorFromRequest(req), body.mode);
  }

  @Get('queue')
  queue(@Req() req: ActorRequest) {
    return this.aiCalls.queue(req.user.id);
  }

  @Delete('queue')
  clearQueue(@Req() req: ActorRequest) {
    return this.aiCalls.clearQueue(req.user.id);
  }

  @Get(':id')
  getOne(@Req() req: ActorRequest, @Param('id') id: string) {
    return this.aiCalls.get(req.user.id, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async removeFromQueue(@Req() req: ActorRequest, @Param('id') id: string): Promise<void> {
    await this.aiCalls.removeFromQueue(req.user.id, id);
  }

  @Get(':id/recording')
  async recording(@Req() req: ActorRequest, @Param('id') id: string, @Res() res: Response) {
    const media = await this.aiCalls.recording(req.user.id, id);
    res.setHeader('Content-Type', media.contentType);
    res.setHeader('Content-Disposition', `inline; filename="${media.filename}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(media.body);
  }

  @Post(':id/keypad')
  @HttpCode(200)
  @Throttle({ short: { limit: 30, ttl: 60_000 } })
  pressKeys(
    @Req() req: ActorRequest,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(aiCallKeypadSchema)) body: AiCallKeypadInput,
  ) {
    return this.aiCalls.pressKeys(actorFromRequest(req), id, body.keys);
  }

  @Post()
  @HttpCode(201)
  @Throttle({ short: { limit: 10, ttl: 60_000 } })
  start(
    @Req() req: ActorRequest,
    @Body(new ZodValidationPipe(startAiCallSchema)) body: StartAiCallInput,
  ) {
    return this.aiCalls.startCall(actorFromRequest(req), body);
  }
}

@Controller('integrations/google-calendar')
@UseGuards(JwtAuthGuard)
export class GoogleCalendarController {
  constructor(private readonly calendar: GoogleCalendarService) {}

  @Get()
  status(@Req() req: ActorRequest) {
    return this.calendar.status(req.user.id);
  }

  @Get('connect-url')
  connectUrl(@Req() req: ActorRequest) {
    return { url: this.calendar.authorizationUrl(req.user.id) };
  }

  @Delete()
  @HttpCode(204)
  async disconnect(@Req() req: ActorRequest): Promise<void> {
    await this.calendar.disconnect(req.user.id);
  }
}
