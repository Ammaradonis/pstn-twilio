import { Module } from '@nestjs/common';

import { GmailService } from './gmail.service';
import { SheetsFollowUpService } from './sheets-follow-up.service';
import { SheetsTimezoneService } from './sheets-timezone.service';
import { SheetsConfig } from './sheets.config';
import { GoogleSheetsOAuthController, SheetsController } from './sheets.controller';
import { SheetsService } from './sheets.service';

// PrismaModule and RedisModule are global.
@Module({
  controllers: [SheetsController, GoogleSheetsOAuthController],
  providers: [
    SheetsConfig,
    SheetsService,
    SheetsTimezoneService,
    GmailService,
    SheetsFollowUpService,
  ],
})
export class SheetsModule {}
