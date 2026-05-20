import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { numberSearchSchema, purchaseNumberSchema } from '@pstn-twilio/shared';
import type { Request } from 'express';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ZodValidationPipe } from '../common/zod.pipe';

import { NumbersService } from './numbers.service';

const updateNumberSchema = z.object({
  friendlyName: z.string().min(1).max(64).optional(),
  tags: z.record(z.unknown()).optional(),
  active: z.boolean().optional(),
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
@UseGuards(JwtAuthGuard, RolesGuard)
export class NumbersController {
  constructor(private readonly numbers: NumbersService) {}

  @Get('phone-number-options/countries')
  countries() {
    return this.numbers.listCountries();
  }

  @Get('numbers/available')
  search(
    @Req() req: ActorRequest,
    @Query(new ZodValidationPipe(numberSearchSchema))
    query: z.infer<typeof numberSearchSchema>,
  ) {
    return this.numbers.searchAvailable(actorFromRequest(req), query);
  }

  @Post('numbers/purchase')
  @HttpCode(201)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  purchase(
    @Req() req: ActorRequest,
    @Body(new ZodValidationPipe(purchaseNumberSchema))
    body: z.infer<typeof purchaseNumberSchema>,
  ) {
    return this.numbers.purchase(actorFromRequest(req), body);
  }

  @Get('numbers')
  list(@Req() req: ActorRequest) {
    return this.numbers.list(actorFromRequest(req));
  }

  @Get('numbers/:numberId')
  getOne(@Req() req: ActorRequest, @Param('numberId') numberId: string) {
    return this.numbers.getById(actorFromRequest(req), numberId);
  }

  @Patch('numbers/:numberId')
  update(
    @Req() req: ActorRequest,
    @Param('numberId') numberId: string,
    @Body(new ZodValidationPipe(updateNumberSchema))
    body: z.infer<typeof updateNumberSchema>,
  ) {
    return this.numbers.update(actorFromRequest(req), numberId, body);
  }

  @Post('numbers/:numberId/configure-webhooks')
  @HttpCode(200)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  configureWebhooks(@Req() req: ActorRequest, @Param('numberId') numberId: string) {
    return this.numbers.configureWebhooks(actorFromRequest(req), numberId);
  }

  @Post('numbers/:numberId/sync')
  @HttpCode(200)
  sync(@Req() req: ActorRequest, @Param('numberId') numberId: string) {
    return this.numbers.sync(actorFromRequest(req), numberId);
  }

  @Post('numbers/:numberId/release')
  @HttpCode(200)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  release(@Req() req: ActorRequest, @Param('numberId') numberId: string) {
    return this.numbers.release(actorFromRequest(req), numberId);
  }

  @Post('numbers/:numberId/deactivate')
  @HttpCode(200)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  deactivate(@Req() req: ActorRequest, @Param('numberId') numberId: string) {
    return this.numbers.deactivate(actorFromRequest(req), numberId);
  }

  @Delete('numbers/:numberId')
  @HttpCode(200)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  remove(@Req() req: ActorRequest, @Param('numberId') numberId: string) {
    return this.numbers.deactivate(actorFromRequest(req), numberId);
  }
}
