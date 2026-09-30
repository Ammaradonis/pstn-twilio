/**
 * Google Sheets & Gmail endpoints.
 *
 *  GET    /api/sheets/status                   connection status
 *  GET    /api/sheets/connect-url              Google consent URL
 *  DELETE /api/sheets                          disconnect
 *  GET    /api/sheets/spreadsheets             all spreadsheets in the account
 *  GET    /api/sheets/tabs/:spreadsheetId      tabs of one spreadsheet
 *  POST   /api/sheets/push                     post-call status push
 *  GET    /api/sheets/follow-ups               recent follow-up emails
 *  POST   /api/sheets/follow-ups/:id/cancel    cancel a pending email
 *  POST   /api/sheets/timezone-check           check/learn from U.S. Conquest
 *  GET    /webhooks/google-sheets/oauth/callback   Google redirect (no JWT)
 */

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { pushCallResultSchema, type PushCallResultDto } from '@pstn-twilio/shared';
import type { Request, Response } from 'express';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod.pipe';

import { SheetsConfig } from './sheets.config';
import { SheetsService, SheetsUnavailableError } from './sheets.service';

type AuthedRequest = Request & { user: { id: string } };

// Google API failures are user-actionable (not connected, no access, bad tab):
// surface the message as a 400 instead of a 500.
async function userFacing<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    if (err instanceof SheetsUnavailableError) throw new BadRequestException(err.message);
    throw err;
  }
}

@Controller('sheets')
@UseGuards(JwtAuthGuard)
export class SheetsController {
  constructor(private readonly sheets: SheetsService) {}

  @Get('status')
  status(@Req() req: AuthedRequest) {
    return this.sheets.status(req.user.id);
  }

  @Get('connect-url')
  connectUrl(@Req() req: AuthedRequest) {
    return userFacing(
      Promise.resolve().then(() => ({ url: this.sheets.authorizationUrl(req.user.id) })),
    );
  }

  @Delete()
  async disconnect(@Req() req: AuthedRequest) {
    await this.sheets.disconnect(req.user.id);
    return { ok: true };
  }

  @Get('spreadsheets')
  spreadsheets(@Req() req: AuthedRequest) {
    return userFacing(this.sheets.listSpreadsheets(req.user.id));
  }

  @Get('tabs/:spreadsheetId')
  tabs(@Req() req: AuthedRequest, @Param('spreadsheetId') spreadsheetId: string) {
    return userFacing(this.sheets.listSheetTabs(req.user.id, spreadsheetId));
  }

  @Post('push')
  @HttpCode(200)
  @Throttle({ short: { limit: 30, ttl: 60_000 } })
  push(
    @Req() req: AuthedRequest,
    @Body(new ZodValidationPipe(pushCallResultSchema)) body: PushCallResultDto,
  ) {
    return userFacing(this.sheets.pushCallResult(req.user.id, body));
  }

  @Get('follow-ups')
  followUps(@Req() req: AuthedRequest) {
    return this.sheets.listFollowUps(req.user.id);
  }

  @Post('follow-ups/:id/cancel')
  @HttpCode(200)
  async cancelFollowUp(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.sheets.cancelFollowUp(req.user.id, id);
    return { ok: true };
  }

  @Post('timezone-check')
  @HttpCode(200)
  @Throttle({ short: { limit: 2, ttl: 60_000 } })
  timezoneCheck(@Req() req: AuthedRequest) {
    return userFacing(this.sheets.checkConquest(req.user.id));
  }
}

@Controller('webhooks/google-sheets')
export class GoogleSheetsOAuthController {
  private readonly logger = new Logger(GoogleSheetsOAuthController.name);

  constructor(
    private readonly sheets: SheetsService,
    private readonly cfg: SheetsConfig,
  ) {}

  @Get('oauth/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const back = (params: Record<string, string>) =>
      res.redirect(302, `${this.cfg.webAppUrl}/settings/sheets?${new URLSearchParams(params)}`);

    if (error || !code || !state) {
      back({ error: error ?? 'cancelled' });
      return;
    }
    try {
      await this.sheets.completeAuthorization(code, state);
      back({ connected: '1' });
    } catch (err) {
      this.logger.warn(`Google Sheets OAuth callback failed: ${(err as Error).message}`);
      back({
        error:
          err instanceof SheetsUnavailableError ? err.message : 'Google Sheets connection failed.',
      });
    }
  }
}
