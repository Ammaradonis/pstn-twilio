import { Body, Controller, Get, HttpCode, Post, Put, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  smsCampaignTestSchema,
  smsCampaignUpdateSchema,
  type SmsCampaignTestInput,
  type SmsCampaignUpdateInput,
} from '@pstn-twilio/shared';
import type { Request } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ZodValidationPipe } from '../common/zod.pipe';

import { SmsCampaignService } from './sms-campaign.service';

type ActorRequest = Request & {
  user: { id: string; email: string; role: UserRole };
};

function actorFromRequest(req: ActorRequest) {
  return { userId: req.user.id, ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

@Controller('sms-campaign')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.OWNER, UserRole.ADMIN)
export class SmsCampaignController {
  constructor(private readonly campaign: SmsCampaignService) {}

  @Get()
  get(@Req() req: ActorRequest) {
    return this.campaign.get(req.user.id);
  }

  /** Starts or pauses the campaign, or changes its text. */
  @Put()
  update(
    @Req() req: ActorRequest,
    @Body(new ZodValidationPipe(smsCampaignUpdateSchema)) body: SmsCampaignUpdateInput,
  ) {
    return this.campaign.update(actorFromRequest(req), body);
  }

  /** Texts the campaign message to the user's own phone. */
  @Post('test')
  @HttpCode(200)
  test(
    @Req() req: ActorRequest,
    @Body(new ZodValidationPipe(smsCampaignTestSchema)) body: SmsCampaignTestInput,
  ) {
    return this.campaign.sendTest(actorFromRequest(req), body.to);
  }
}
