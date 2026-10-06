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
 *  GET    /api/sheets/follow-ups/:id/message   rendered email (for contact forms)
 *  POST   /api/sheets/follow-ups/:id/sent      contact-form follow-up sent by hand
 *  POST   /api/email-finder/start              queue a tab's rows for the email finder
 *  GET    /api/email-finder/status             progress for a tab
 *  POST   /api/email-finder/:jobId/{pause|resume|cancel}
 *  POST   /api/email-finder/worker/{claim|results|heartbeat}   (worker token)
 *  POST   /api/sheets/timezone-check           check/learn from U.S. Conquest
 *  GET    /webhooks/google-sheets/oauth/callback   Google redirect (no JWT)
 */

import { timingSafeEqual } from 'crypto';

import {
  BadRequestException,
  Body,
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
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
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import {
  pushCallResultSchema,
  type PushCallResultDto,
  type SheetsFollowUpMessageDto,
} from '@pstn-twilio/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod.pipe';

import { ContactFormService } from './contact-form.service';
import { EmailFinderService } from './email-finder.service';
import { FollowUpRenderer } from './follow-up-renderer.service';
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
  constructor(
    private readonly sheets: SheetsService,
    private readonly renderer: FollowUpRenderer,
  ) {}

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

  @Get('follow-ups/:id/message')
  async followUpMessage(
    @Req() req: AuthedRequest,
    @Param('id') id: string,
  ): Promise<SheetsFollowUpMessageDto> {
    const log = await this.sheets.followUpLog(req.user.id, id);
    if (!log.emailTemplate) throw new BadRequestException('This push has no follow-up email.');
    const rendered = await this.renderer.render(log, req.user.id);
    if (!rendered) throw new BadRequestException('The follow-up needs data this lead lacks.');
    return { subject: rendered.subject, body: rendered.body, contactFormUrl: log.contactFormUrl };
  }

  @Post('follow-ups/:id/sent')
  @HttpCode(200)
  async markFollowUpSent(@Req() req: AuthedRequest, @Param('id') id: string) {
    await this.sheets.markFollowUpSent(req.user.id, id);
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

type TabQuery = { spreadsheetId?: string; sheetTitle?: string };

function tabFrom(body: TabQuery): { spreadsheetId: string; sheetTitle: string } {
  const spreadsheetId = body.spreadsheetId?.trim();
  const sheetTitle = body.sheetTitle;
  if (!spreadsheetId || !sheetTitle) {
    throw new BadRequestException('spreadsheetId and sheetTitle are required.');
  }
  return { spreadsheetId, sheetTitle };
}

@Controller('email-finder')
@UseGuards(JwtAuthGuard)
export class EmailFinderController {
  constructor(private readonly finder: EmailFinderService) {}

  @Post('start')
  @HttpCode(200)
  start(@Req() req: AuthedRequest, @Body() body: TabQuery) {
    const { spreadsheetId, sheetTitle } = tabFrom(body);
    return userFacing(this.finder.start(req.user.id, spreadsheetId, sheetTitle));
  }

  @Get('status')
  status(@Req() req: AuthedRequest, @Query() query: TabQuery) {
    const { spreadsheetId, sheetTitle } = tabFrom(query);
    return this.finder.status(req.user.id, spreadsheetId, sheetTitle);
  }

  @Post(':jobId/pause')
  @HttpCode(200)
  pause(@Req() req: AuthedRequest, @Param('jobId') jobId: string) {
    return this.finder.setStatus(req.user.id, jobId, 'PAUSED');
  }

  @Post(':jobId/resume')
  @HttpCode(200)
  resume(@Req() req: AuthedRequest, @Param('jobId') jobId: string) {
    return this.finder.setStatus(req.user.id, jobId, 'RUNNING');
  }

  @Post(':jobId/cancel')
  @HttpCode(200)
  cancel(@Req() req: AuthedRequest, @Param('jobId') jobId: string) {
    return this.finder.setStatus(req.user.id, jobId, 'CANCELLED');
  }
}

/** The email finder worker on the user's PC authenticates with a shared token. */
@Injectable()
export class FinderWorkerGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('EMAIL_FINDER_WORKER_TOKEN')?.trim();
    if (!expected) throw new ServiceUnavailableException('EMAIL_FINDER_WORKER_TOKEN is not set.');
    const given = context.switchToHttp().getRequest<Request>().headers['x-worker-token'];
    const a = Buffer.from(typeof given === 'string' ? given : '');
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new UnauthorizedException();
    return true;
  }
}

@Controller('email-finder/worker')
@UseGuards(FinderWorkerGuard)
export class EmailFinderWorkerController {
  constructor(
    private readonly finder: EmailFinderService,
    private readonly forms: ContactFormService,
  ) {}

  @Post('heartbeat')
  @HttpCode(200)
  async heartbeat() {
    await this.finder.heartbeat();
    return { ok: true };
  }

  @Post('claim')
  @HttpCode(200)
  async claim(@Body() body: { max?: number }) {
    return { rows: await this.finder.claim(Number(body?.max) || 3) };
  }

  @Post('results')
  @HttpCode(200)
  results(@Body() body: unknown) {
    const parsed = finderResultsSchema.safeParse(body);
    if (!parsed.success) {
      // Name the fields so a worker/API version mismatch shows up in the worker log.
      const issues = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new BadRequestException(`Invalid email finder results (${issues}).`);
    }
    return this.finder.submit(parsed.data.results);
  }

  @Post('forms/claim')
  @HttpCode(200)
  async claimForms() {
    return { forms: await this.forms.claim() };
  }

  @Post('forms/:id/arm')
  @HttpCode(200)
  armForm(@Param('id') id: string, @Body() body: unknown) {
    const parsed = formReceiptSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid form lease.');
    return this.forms.arm(id, parsed.data.leaseToken);
  }

  @Post('forms/:id/result')
  @HttpCode(200)
  formResult(@Param('id') id: string, @Body() body: unknown) {
    const parsed = formReceiptSchema
      .extend({
        status: z.enum(['SENT', 'MANUAL', 'FAILED']),
        notes: z.string().max(500).optional(),
      })
      .safeParse(body);
    if (!parsed.success) throw new BadRequestException('Invalid form result.');
    return this.forms.complete(id, parsed.data.leaseToken, parsed.data.status, parsed.data.notes);
  }
}

const formReceiptSchema = z.object({ leaseToken: z.string().uuid() });
const publicHttpUrl = z
  .string()
  .max(1000)
  .url()
  .refine((v) => /^https?:\/\//i.test(v));
const finderResultsSchema = z.object({
  results: z
    .array(
      z
        .object({
          id: z.string().uuid(),
          leaseToken: z.string().uuid(),
          status: z.enum(['FOUND', 'CONTACT_FORM', 'NOT_FOUND', 'FAILED', 'RETRY']),
          email: z.string().max(254).email().nullish(),
          emailType: z.enum(['decision-maker', 'business', 'staff']).nullish(),
          confidence: z.number().int().min(0).max(100).nullish(),
          sourceUrl: publicHttpUrl.nullish(),
          decisionMaker: z.string().max(200).nullish(),
          contactFormUrl: publicHttpUrl.nullish(),
          notes: z.string().max(1000).nullish(),
          method: z.string().max(200).nullish(),
          // Cleaned field by field in the service: one odd link mustn't reject a result.
          enrichment: z.record(z.string().max(1000)).nullish(),
          researchComplete: z.boolean(),
          retryAfter: z.number().int().min(60).max(86400).optional(),
        })
        .superRefine((r, ctx) => {
          if (r.status === 'FOUND' && !r.email)
            ctx.addIssue({ code: 'custom', message: 'FOUND requires email' });
          if (
            r.status === 'CONTACT_FORM' &&
            (!r.contactFormUrl || !r.researchComplete || r.email)
          ) {
            ctx.addIssue({
              code: 'custom',
              message: 'CONTACT_FORM requires complete research and no email',
            });
          }
        }),
    )
    .min(1)
    .max(50),
});
