import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';

import { TwilioService } from '../twilio/twilio.service';

@Injectable()
export class TwilioSignatureGuard implements CanActivate {
  private readonly logger = new Logger(TwilioSignatureGuard.name);

  constructor(private readonly twilio: TwilioService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const signature = req.header('x-twilio-signature') ?? req.header('X-Twilio-Signature');
    const params = (req.body ?? {}) as Record<string, unknown>;
    const url = this.buildWebhookUrl(req);

    const valid = this.twilio.validateSignature(signature ?? undefined, url, params);
    if (!valid) {
      this.logger.warn(`Rejected Twilio webhook signature verification: ${url}`);
      this.logger.warn(`Received X-Twilio-Signature: ${signature}`);
      const token = this.twilio.authToken ?? '';
      this.logger.warn(
        `Configured TWILIO_AUTH_TOKEN length: ${token.length}, prefix: ${token ? token.slice(0, 4) : ''}...`,
      );
      return false;
    }
    return true;
  }

  private buildWebhookUrl(req: Request): string {
    const base = this.twilio.webhookBaseUrl;
    const path = req.originalUrl ?? req.url ?? '';
    return `${base}${path}`;
  }
}
