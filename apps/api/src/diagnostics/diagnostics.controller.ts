import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { type TwilioService } from '../twilio/twilio.service';

import { type DiagnosticsService } from './diagnostics.service';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class DiagnosticsController {
  constructor(
    private readonly service: DiagnosticsService,
    private readonly twilio: TwilioService,
  ) {}

  @Get('settings')
  settings() {
    const webhooks = this.twilio.defaultWebhookUrls();
    return {
      webhooks,
      defaultCountry: this.twilio.defaultCountry,
      twilioAccountSid: this.twilio.accountSid,
      webhookBaseUrl: this.twilio.webhookBaseUrl,
    };
  }

  @Get('settings/twilio/validate')
  async validateTwilio() {
    const ok = await this.twilio.validateCredentials();
    return { status: ok ? 'ok' : 'down' };
  }

  @Post('settings/twilio/sync')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  async syncTwilio() {
    // The full per-number sync is exposed under /api/numbers/:id/sync. This
    // endpoint just validates credentials so the diagnostics page has a
    // single "test connection" button.
    const ok = await this.twilio.validateCredentials();
    return { status: ok ? 'ok' : 'down' };
  }

  @Get('diagnostics')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  diagnostics() {
    return this.service.report();
  }
}
