import { Module } from '@nestjs/common';

import { EmailFinderService } from './email-finder.service';
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
  ],
  providers: [
    SheetsConfig,
    SheetsService,
    SheetsTimezoneService,
    GmailService,
    SheetsFollowUpService,
    EmailFinderService,
    FinderWorkerGuard,
  ],
})
export class SheetsModule {}
