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

    this.logger.log(
      `Twilio Webhook: method=${req.method}, contentType=${req.header('content-type')}, bodyKeys=[${Object.keys(params).join(', ')}], url=${url}`,
    );

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
    // If behind a proxy, X-Forwarded-Proto and X-Forwarded-Host contain the original protocol and host
    const headers = req.headers ?? {};
    const proto = (headers['x-forwarded-proto'] as string) ?? req.protocol ?? 'https';
    const host = (headers['x-forwarded-host'] as string) ?? headers['host'] ?? '';

    if (host) {
      const cleanProto = proto.split(',')[0].trim();
      const cleanHost = host.split(',')[0].trim();
      const path = req.originalUrl ?? req.url ?? '';
      return `${cleanProto}://${cleanHost}${path}`;
    }

    const base = this.twilio.webhookBaseUrl;
    const path = req.originalUrl ?? req.url ?? '';
    return `${base}${path}`;
  }
}
