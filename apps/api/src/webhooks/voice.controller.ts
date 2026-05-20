import { Body, Controller, Header, HttpCode, Logger, Post, UseGuards } from '@nestjs/common';

import { TwilioSignatureGuard } from './twilio-signature.guard';
import {
  type CallStatusParams,
  type InboundVoiceParams,
  type OutboundVoiceParams,
  type VoiceWebhookService,
} from './voice.service';

@Controller('webhooks/twilio/voice')
@UseGuards(TwilioSignatureGuard)
export class VoiceWebhookController {
  private readonly logger = new Logger(VoiceWebhookController.name);

  constructor(private readonly service: VoiceWebhookService) {}

  @Post('inbound')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  async inbound(@Body() body: InboundVoiceParams): Promise<string> {
    try {
      return await this.service.handleInbound(body);
    } catch (err) {
      this.logger.error(
        `Inbound voice webhook failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      return this.service.handleFallback();
    }
  }

  @Post('outbound')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  async outbound(@Body() body: OutboundVoiceParams): Promise<string> {
    const identity =
      body.From && body.From.startsWith('client:') ? body.From.slice('client:'.length) : undefined;
    try {
      return await this.service.handleOutbound(body, identity);
    } catch (err) {
      this.logger.error(
        `Outbound voice webhook failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      return this.service.handleFallback();
    }
  }

  @Post('status')
  @HttpCode(204)
  async status(@Body() body: CallStatusParams): Promise<void> {
    try {
      await this.service.handleStatus(body);
    } catch (err) {
      this.logger.error(
        `Voice status callback failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }

  @Post('fallback')
  @HttpCode(200)
  @Header('Content-Type', 'text/xml')
  fallback(): string {
    return this.service.handleFallback();
  }
}
