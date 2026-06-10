import { Body, Controller, Header, HttpCode, Logger, Post, Query, UseGuards } from '@nestjs/common';

import { MessagingWebhookService, InboundParams, StatusParams } from './messaging.service';
import { TwilioSignatureGuard } from './twilio-signature.guard';

@Controller('webhooks/twilio/messaging')
@UseGuards(TwilioSignatureGuard)
export class MessagingWebhookController {
  private readonly logger = new Logger(MessagingWebhookController.name);

  constructor(private readonly service: MessagingWebhookService) {}

  @Post('inbound')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  async inbound(@Body() body: InboundParams): Promise<string> {
    try {
      await this.service.handleInbound(body);
    } catch (err) {
      this.logger.error(
        `Inbound SMS webhook failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
    return '<?xml version="1.0" encoding="UTF-8"?><Response/>';
  }

  @Post('status')
  @HttpCode(204)
  async status(@Body() body: StatusParams, @Query('messageId') messageId?: string): Promise<void> {
    try {
      await this.service.handleStatus(body, { localMessageId: messageId });
    } catch (err) {
      this.logger.error(
        `Status callback failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }
}
