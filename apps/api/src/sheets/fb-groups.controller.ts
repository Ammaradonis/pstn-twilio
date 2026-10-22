/**
 * Facebook groups endpoints.
 *
 *  POST /api/fb-groups/start                  start (or resume) the run
 *  GET  /api/fb-groups/status                 scoreboard for the button
 *  POST /api/fb-groups/:runId/{pause|resume|cancel}
 *  POST /api/fb-groups/worker/{tick|progress} (worker token)
 *
 * The user-facing routes are what the Dial page's button calls; the worker
 * routes are the only way the run advances, and they are guarded by the same
 * shared token the email finder worker uses.
 */

import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod.pipe';

import { FbGroupsService, FB_STAGES, type FbGroupsProgress } from './fb-groups.service';
import { FinderWorkerGuard } from './sheets.controller';

type AuthedRequest = Request & { user: { id: string } };

const progressSchema = z.object({
  runId: z.string().uuid(),
  searches: z.number().int().min(0).max(500).optional(),
  groupsFound: z.number().int().min(0).max(500).optional(),
  joined: z.number().int().min(0).max(100).optional(),
  likes: z.number().int().min(0).max(500).optional(),
  comments: z.number().int().min(0).max(100).optional(),
  replies: z.number().int().min(0).max(100).optional(),
  follows: z.number().int().min(0).max(100).optional(),
  dms: z.number().int().min(0).max(100).optional(),
  reviewQueued: z.number().int().min(0).max(500).optional(),
  stage: z.enum(['SEARCH', 'JOIN', 'ENGAGE', 'OUTREACH']).optional(),
  note: z.string().max(500).optional(),
  plan: z
    .object({
      addresses: z.number().int().min(0),
      covered: z.number().int().min(0),
      searches: z.number().int().min(0),
      uncovered: z.number().int().min(0),
      builtAt: z.string().nullable().default(null),
    })
    .optional(),
});

/** The pipeline's stages, exported so a test can assert the schema allows each. */
export const FB_GROUP_STAGES = FB_STAGES;

@Controller('fb-groups')
@UseGuards(JwtAuthGuard)
export class FbGroupsController {
  constructor(private readonly groups: FbGroupsService) {}

  /** The "FB groups" button. Idempotent: an open run is resumed, not duplicated. */
  @Post('start')
  @HttpCode(200)
  start(@Req() req: AuthedRequest) {
    return this.groups.start(req.user.id);
  }

  @Get('status')
  status(@Req() req: AuthedRequest) {
    return this.groups.status(req.user.id);
  }

  @Post(':runId/pause')
  @HttpCode(200)
  pause(@Req() req: AuthedRequest, @Param('runId') runId: string) {
    return this.groups.setStatus(req.user.id, runId, 'PAUSED');
  }

  @Post(':runId/resume')
  @HttpCode(200)
  resume(@Req() req: AuthedRequest, @Param('runId') runId: string) {
    return this.groups.setStatus(req.user.id, runId, 'RUNNING');
  }

  @Post(':runId/cancel')
  @HttpCode(200)
  cancel(@Req() req: AuthedRequest, @Param('runId') runId: string) {
    return this.groups.setStatus(req.user.id, runId, 'CANCELLED');
  }
}

@Controller('fb-groups/worker')
@UseGuards(FinderWorkerGuard)
export class FbGroupsWorkerController {
  constructor(private readonly groups: FbGroupsService) {}

  @Post('tick')
  @HttpCode(200)
  tick() {
    return this.groups.tick();
  }

  @Post('progress')
  @HttpCode(200)
  progress(@Body(new ZodValidationPipe(progressSchema)) body: FbGroupsProgress) {
    return this.groups.progress(body);
  }
}
