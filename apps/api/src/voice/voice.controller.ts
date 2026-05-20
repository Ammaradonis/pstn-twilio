import { Body, Controller, Get, HttpCode, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { prepareOutboundCallSchema, voiceTokenRequestSchema } from '@pstn-twilio/shared';
import type { Request } from 'express';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod.pipe';

import { VoiceService } from './voice.service';

const identityQuerySchema = z.object({
  numberId: z.string().uuid().optional(),
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
export class VoiceController {
  constructor(private readonly voice: VoiceService) {}

  @Post('voice/token')
  @HttpCode(200)
  @Throttle({ short: { limit: 20, ttl: 60_000 } })
  token(
    @Req() req: ActorRequest,
    @Body(new ZodValidationPipe(voiceTokenRequestSchema))
    body: z.infer<typeof voiceTokenRequestSchema>,
  ) {
    return this.voice.issueToken(actorFromRequest(req), body.numberId);
  }

  @Get('voice/identity')
  identity(
    @Req() req: ActorRequest,
    @Query(new ZodValidationPipe(identityQuerySchema))
    query: z.infer<typeof identityQuerySchema>,
  ) {
    return this.voice.getIdentity(actorFromRequest(req), query.numberId);
  }

  @Get('voice/device-config')
  deviceConfig() {
    return this.voice.getDeviceConfig();
  }

  @Post('calls/prepare-outbound')
  @HttpCode(200)
  prepareOutbound(
    @Req() req: ActorRequest,
    @Body(new ZodValidationPipe(prepareOutboundCallSchema))
    body: z.infer<typeof prepareOutboundCallSchema>,
  ) {
    return this.voice.prepareOutbound(actorFromRequest(req), {
      selectedNumberId: body.selectedNumberId,
      destinationNumber: body.destinationNumber,
    });
  }
}
