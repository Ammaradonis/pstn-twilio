import { Module } from '@nestjs/common';

import { ContactFormService } from './contact-form.service';
import { EmailFinderService } from './email-finder.service';
import { FbGroupsController, FbGroupsWorkerController } from './fb-groups.controller';
import { FbGroupsService } from './fb-groups.service';
import { FollowUpRenderer } from './follow-up-renderer.service';
import { GmailService } from './gmail.service';
import { MetaAdsController, MetaAdsWorkerController } from './meta-ads.controller';
import { MetaAdsService } from './meta-ads.service';
import { SheetsFollowUpService } from './sheets-follow-up.service';
import { SheetsTimezoneService } from './sheets-timezone.service';
import { SheetsConfig } from './sheets.config';
import {
  EmailFinderController,
  EmailFinderWorkerController,
  FinderWorkerGuard,
  GoogleSheetsOAuthController,
  SheetsController,
} from './sheets.controller';
import { SheetsService } from './sheets.service';

// PrismaModule and RedisModule are global.
@Module({
  controllers: [
    SheetsController,
    GoogleSheetsOAuthController,
    EmailFinderController,
    EmailFinderWorkerController,
    FbGroupsController,
    FbGroupsWorkerController,
    MetaAdsController,
    MetaAdsWorkerController,
  ],
  providers: [
    SheetsConfig,
    SheetsService,
    SheetsTimezoneService,
    GmailService,
    FollowUpRenderer,
    SheetsFollowUpService,
    EmailFinderService,
    ContactFormService,
    FbGroupsService,
    MetaAdsService,
    FinderWorkerGuard,
  ],
})
export class SheetsModule {}
