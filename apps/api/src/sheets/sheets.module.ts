import { Module } from '@nestjs/common';

import { ContactFormService } from './contact-form.service';
import { EmailFinderService } from './email-finder.service';
import { FbGroupsController, FbGroupsWorkerController } from './fb-groups.controller';
import { FbGroupsService } from './fb-groups.service';
import { FollowUpRenderer } from './follow-up-renderer.service';
import { GmailService } from './gmail.service';
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
    FinderWorkerGuard,
  ],
})
export class SheetsModule {}
