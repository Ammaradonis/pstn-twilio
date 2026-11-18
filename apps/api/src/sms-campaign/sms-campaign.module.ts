import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';

import { SmsCampaignController } from './sms-campaign.controller';
import { SmsCampaignService } from './sms-campaign.service';

/** The cold SMS campaign to called leads, sent from the toll-free line. */
@Module({
  imports: [AuditModule],
  controllers: [SmsCampaignController],
  providers: [SmsCampaignService],
})
export class SmsCampaignModule {}
