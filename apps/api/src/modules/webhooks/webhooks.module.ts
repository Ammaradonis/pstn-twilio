// Implemented in Phases 6–8: /webhooks/twilio/voice/{inbound,outbound,status,fallback}
// and /webhooks/twilio/messaging/{inbound,status}, all gated by TwilioSignatureGuard.
import { Module } from '@nestjs/common';

@Module({})
export class WebhooksModule {}
