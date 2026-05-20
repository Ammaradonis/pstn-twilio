import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { MessageDirection, UserRole } from '@prisma/client';
import { sendMessageSchema } from '@pstn-twilio/shared';
import type { Request } from 'express';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod.pipe';

import { MessagesService } from './messages.service';

const listQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const searchQuerySchema = z.object({
  query: z.string().min(1).max(200).optional(),
  from: z.string().min(1).max(20).optional(),
  to: z.string().min(1).max(20).optional(),
  direction: z.nativeEnum(MessageDirection).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
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
export class MessagesController {
  constructor(private readonly messages: MessagesService) {}

  @Get('numbers/:numberId/messages')
  list(
    @Req() req: ActorRequest,
    @Param('numberId') numberId: string,
    @Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>,
  ) {
    return this.messages.list(actorFromRequest(req), numberId, query);
  }

  @Get('numbers/:numberId/messages/:messageId')
  getOne(
    @Req() req: ActorRequest,
    @Param('numberId') numberId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.messages.getOne(actorFromRequest(req), numberId, messageId);
  }

  @Post('numbers/:numberId/messages')
  @HttpCode(201)
  @Throttle({ short: { limit: 10, ttl: 60_000 } })
  send(
    @Req() req: ActorRequest,
    @Param('numberId') numberId: string,
    @Body(new ZodValidationPipe(sendMessageSchema))
    body: z.infer<typeof sendMessageSchema>,
  ) {
    return this.messages.send(actorFromRequest(req), numberId, body);
  }

  @Post('numbers/:numberId/messages/:messageId/retry')
  @HttpCode(201)
  @Throttle({ short: { limit: 10, ttl: 60_000 } })
  retry(
    @Req() req: ActorRequest,
    @Param('numberId') numberId: string,
    @Param('messageId') messageId: string,
  ) {
    return this.messages.retry(actorFromRequest(req), numberId, messageId);
  }

  @Get('messages/search')
  search(
    @Req() req: ActorRequest,
    @Query(new ZodValidationPipe(searchQuerySchema)) query: z.infer<typeof searchQuerySchema>,
  ) {
    return this.messages.search(actorFromRequest(req), query);
  }
}
