/**
 * Meta Ads Library endpoints.
 *
 *  GET  /api/meta-ads/status?spreadsheetId=&sheetTitle=   evidence counts for the button
 *  POST /api/meta-ads/filter                              copy the matching rows into a new tab
 *  POST /api/meta-ads/worker/evidence                     (worker token) upload verified matches
 *
 * The filter route is what the Dial page's "Meta ad filter" button calls; the
 * worker route is the only way evidence gets in, guarded by the same shared
 * token the email finder and Facebook groups workers use.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { MetaAdsEvidenceUploadDto } from '@pstn-twilio/shared';
import type { Request } from 'express';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod.pipe';

import { MetaAdsService } from './meta-ads.service';
import { FinderWorkerGuard, userFacing } from './sheets.controller';

type AuthedRequest = Request & { user: { id: string } };

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const filterSchema = z.object({
  spreadsheetId: z.string().min(20).max(200),
  sheetTitle: z.string().min(1).max(200),
  // The default filter is "still advertising now".
  mode: z.enum(['ACTIVE', 'PAST']).default('ACTIVE'),
});

// Google's tab ids are positive int32 values, so they go up to 2,147,483,647.
// The first version of this schema capped them at 2,000,000,000, and every tab
// above that (Massachusetts was 2,079,617,744) made the worker's whole batch
// fail with a 400: nothing was stored for it and the filter looked dead.
export const MAX_SHEET_ID = 2_147_483_647;
export const MAX_ROW_INDEX = 10_000_000;

export const evidenceSchema = z.object({
  observations: z
    .array(
      z.object({
        spreadsheetId: z.string().min(20).max(200),
        sheetId: z.number().int().min(0).max(MAX_SHEET_ID),
        sheetTitle: z.string().min(1).max(200),
        rowIndex: z.number().int().min(2).max(MAX_ROW_INDEX),
        schoolTitle: z.string().min(1).max(500),
        // Empty when the match was by name and the tab has no page of its own.
        facebookUrl: z.string().max(1000),
        advertiserName: z.string().min(1).max(500),
        advertiserUrl: z.string().min(1).max(1000),
        adId: z.string().regex(/^\d{1,30}$/),
        status: z.enum(['ACTIVE', 'INACTIVE']),
        startedAt: isoDay.nullable(),
        endedAt: isoDay.nullable(),
        observedAt: z.string().datetime({ offset: true }),
        // Older workers only uploaded page-verified pairs, so a missing field
        // means "page".
        matchKind: z.enum(['page', 'name']).default('page'),
      }),
    )
    .min(1)
    .max(1000),
});

@Controller('meta-ads')
@UseGuards(JwtAuthGuard)
export class MetaAdsController {
  constructor(private readonly metaAds: MetaAdsService) {}

  @Get('status')
  status(
    @Req() req: AuthedRequest,
    @Query('spreadsheetId') spreadsheetId?: string,
    @Query('sheetTitle') sheetTitle?: string,
  ) {
    if (!spreadsheetId || !sheetTitle) {
      throw new BadRequestException('spreadsheetId and sheetTitle are required.');
    }
    return userFacing(this.metaAds.status(req.user.id, spreadsheetId, sheetTitle));
  }

  /** The "Meta ad filter" button: a new tab in the same spreadsheet. */
  @Post('filter')
  @HttpCode(200)
  @Throttle({ short: { limit: 10, ttl: 60_000 } })
  filter(
    @Req() req: AuthedRequest,
    @Body(new ZodValidationPipe(filterSchema))
    body: { spreadsheetId: string; sheetTitle: string; mode: 'ACTIVE' | 'PAST' },
  ) {
    return userFacing(
      this.metaAds.filter(req.user.id, body.spreadsheetId, body.sheetTitle, body.mode),
    );
  }
}

@Controller('meta-ads/worker')
@UseGuards(FinderWorkerGuard)
export class MetaAdsWorkerController {
  constructor(private readonly metaAds: MetaAdsService) {}

  @Post('evidence')
  @HttpCode(200)
  evidence(@Body(new ZodValidationPipe(evidenceSchema)) body: MetaAdsEvidenceUploadDto) {
    return this.metaAds.saveEvidence(body.observations);
  }
}
