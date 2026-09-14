import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { startAiCallSchema, type StartAiCallInput } from '@pstn-twilio/shared';
import type { Request } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod.pipe';

import { AiCallsService } from './ai-calls.service';
import { GoogleCalendarService } from './google-calendar.service';

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
  constructor(private readonly aiCalls: AiCallsService) {}

  @Get('config')
  config(@Req() req: ActorRequest) {
    return this.aiCalls.config(req.user.id);
  }

  @Get()
  list(@Req() req: ActorRequest, @Query('limit') limit?: string) {
    return this.aiCalls.list(req.user.id, limit ? Number.parseInt(limit, 10) || 20 : 20);
  }

  @Get(':id')
  getOne(@Req() req: ActorRequest, @Param('id') id: string) {
    return this.aiCalls.get(req.user.id, id);
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
