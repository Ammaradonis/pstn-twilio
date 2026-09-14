import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  HttpCode,
  Injectable,
  Logger,
  Post,
  Query,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { safeEqual } from '../common/secret-box';

import { AiCallingConfig } from './ai-calling.config';
import { AiCallsService, type VapiServerMessage } from './ai-calls.service';
import { CalendarUnavailableError, GoogleCalendarService } from './google-calendar.service';

// Vapi sends the shared secret configured on the assistant and tool servers.
@Injectable()
export class VapiSecretGuard implements CanActivate {
  constructor(private readonly settings: AiCallingConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.settings.vapiWebhookSecret;
    const request = context.switchToHttp().getRequest<Request>();
    const provided = request.headers['x-vapi-secret'];
    if (!expected || typeof provided !== 'string' || !safeEqual(provided, expected)) {
      throw new UnauthorizedException();
    }
    return true;
  }
}

@Controller('webhooks/vapi')
export class VapiWebhookController {
  private readonly logger = new Logger(VapiWebhookController.name);

  constructor(private readonly aiCalls: AiCallsService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(VapiSecretGuard)
  async handle(@Body() body: { message?: VapiServerMessage }): Promise<Record<string, unknown>> {
    const message = body?.message;
    if (!message?.type) return {};
    try {
      return await this.aiCalls.handleWebhook(message);
    } catch (err) {
      this.logger.error(`Vapi ${message.type} webhook failed: ${(err as Error).message}`);
      return message.type === 'assistant-request'
        ? { error: 'The agent is temporarily unavailable.' }
        : {};
    }
  }
}

@Controller('webhooks/google-calendar')
export class GoogleCalendarOAuthController {
  private readonly logger = new Logger(GoogleCalendarOAuthController.name);

  constructor(
    private readonly calendar: GoogleCalendarService,
    private readonly settings: AiCallingConfig,
  ) {}

  @Get('oauth/callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const back = (params: Record<string, string>) =>
      res.redirect(
        302,
        `${this.settings.webAppUrl}/settings?${new URLSearchParams(params).toString()}`,
      );

    if (error || !code || !state) {
      back({ calendar: 'error', reason: error ?? 'missing_code' });
      return;
    }
    try {
      await this.calendar.completeAuthorization(code, state);
      back({ calendar: 'connected' });
    } catch (err) {
      const reason =
        err instanceof CalendarUnavailableError
          ? err.message
          : 'Google Calendar connection failed.';
      this.logger.warn(`Google OAuth callback failed: ${(err as Error).message}`);
      back({ calendar: 'error', reason });
    }
  }
}
