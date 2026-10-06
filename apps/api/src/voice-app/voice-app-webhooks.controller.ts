import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import twilio from 'twilio';

import { TwilioSignatureGuard } from '../webhooks/twilio-signature.guard';

import { VoiceAppCallsService } from './voice-app-calls.service';
import { VoiceAppSettingsService } from './voice-app-settings.service';

type TwilioParams = Record<string, string | undefined>;

/** Twilio callbacks for voice app calls, call screening and phone verification. */
@Controller('webhooks/twilio/voice-app')
@UseGuards(TwilioSignatureGuard)
export class VoiceAppWebhooksController {
  private readonly logger = new Logger(VoiceAppWebhooksController.name);

  constructor(
    private readonly calls: VoiceAppCallsService,
    private readonly settings: VoiceAppSettingsService,
  ) {}

  @Post('dial-complete')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  async dialComplete(@Body() body: TwilioParams): Promise<string> {
    try {
      return await this.calls.dialComplete(body);
    } catch (err) {
      this.fail('dial-complete', err);
      // Still take a message rather than drop the caller.
      return this.calls.voicemailTwiml(null, null);
    }
  }

  @Post('leg-status')
  @HttpCode(204)
  async legStatus(
    @Body() body: TwilioParams,
    @Query('leg') leg?: string,
    @Query('parent') parent?: string,
  ): Promise<void> {
    try {
      await this.calls.legStatus(leg, parent, body);
    } catch (err) {
      this.fail('leg-status', err);
    }
  }

  @Post('screen')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  async screen(
    @Body() body: TwilioParams,
    @Query('fid') fid = '',
    @Query('parent') parent = '',
  ): Promise<string> {
    try {
      return await this.calls.screenTwiml(fid, parent, body.From ?? '');
    } catch (err) {
      this.fail('screen', err);
      return hangup();
    }
  }

  @Post('screen-result')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  async screenResult(
    @Body() body: TwilioParams,
    @Query('fid') fid = '',
    @Query('parent') parent = '',
  ): Promise<string> {
    try {
      return await this.calls.screenResult(fid, parent, body);
    } catch (err) {
      this.fail('screen-result', err);
      return hangup();
    }
  }

  @Post('voicemail-done')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  voicemailDone(): string {
    return this.calls.voicemailDoneTwiml();
  }

  @Post('voicemail-recording')
  @HttpCode(204)
  async voicemailRecording(@Body() body: TwilioParams): Promise<void> {
    try {
      await this.calls.voicemailRecording(body);
    } catch (err) {
      this.fail('voicemail-recording', err);
    }
  }

  @Post('verify')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  async verify(@Query('fid') fid = '', @Query('attempt') attempt = '1'): Promise<string> {
    try {
      return await this.settings.verifyPromptTwiml(fid, toAttempt(attempt));
    } catch (err) {
      this.fail('verify', err);
      return hangup();
    }
  }

  @Post('verify-check')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  async verifyCheck(
    @Body() body: TwilioParams,
    @Query('fid') fid = '',
    @Query('attempt') attempt = '1',
  ): Promise<string> {
    try {
      return await this.settings.verifyCheckTwiml(fid, toAttempt(attempt), body.Digits);
    } catch (err) {
      this.fail('verify-check', err);
      return hangup();
    }
  }

  @Post('verify-status')
  @HttpCode(204)
  async verifyStatus(@Body() body: TwilioParams, @Query('fid') fid = ''): Promise<void> {
    try {
      await this.settings.verifyCallEnded(fid, body.CallSid);
    } catch (err) {
      this.fail('verify-status', err);
    }
  }

  private fail(endpoint: string, err: unknown): void {
    this.logger.error(
      `Voice app webhook ${endpoint} failed: ${err instanceof Error ? err.message : 'unknown'}`,
    );
  }
}

/**
 * Recorded voicemail greetings for Twilio <Play>. Twilio fetches media without
 * a request signature, so the unguessable token is the credential.
 */
@Controller('webhooks/twilio/voice-app/greeting')
export class VoiceAppGreetingController {
  constructor(private readonly settings: VoiceAppSettingsService) {}

  @Get(':token')
  async greeting(@Param('token') token: string, @Res() res: Response): Promise<void> {
    if (!/^[A-Za-z0-9_-]{20,64}(\.wav)?$/.test(token)) throw new NotFoundException();
    const greeting = await this.settings.greetingByToken(token);
    res.setHeader('Content-Type', greeting.contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(greeting.audio);
  }
}

function toAttempt(value: string): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 1;
}

function hangup(): string {
  const response = new twilio.twiml.VoiceResponse();
  response.hangup();
  return response.toString();
}
