/**
 * Renders the next email of a push's follow-up sequence, for the Gmail
 * sweep, the contact-form hand-off and the "copy message" button alike.
 */

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, SheetsPushLog } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

import {
  hasSequence,
  loadSequence,
  renderSequenceEmail,
  SEQUENCE_LENGTH,
  type Region,
} from './follow-up-sequences';
import { buildSequenceVars, regionFor, type RowData } from './follow-up-vars';
import { SheetsConfig } from './sheets.config';
import { SheetsService } from './sheets.service';

export interface RenderedFollowUp {
  subject: string;
  body: string;
  // The email actually rendered: emails that need data this lead lacks are skipped.
  step: number;
  region: Region;
}

@Injectable()
export class FollowUpRenderer {
  private readonly logger = new Logger(FollowUpRenderer.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sheets: SheetsService,
    private readonly cfg: SheetsConfig,
  ) {}

  /** Email `fromStep` of the sequence, or the next one this lead has data for; null when none is left. */
  async render(
    log: SheetsPushLog,
    userId: string,
    fromStep = log.sequenceStep,
  ): Promise<RenderedFollowUp | null> {
    const key = log.emailTemplate;
    if (!key || !hasSequence(key)) throw new Error(`No follow-up sequence for "${key ?? ''}".`);
    const row = await this.rowFor(log, userId);
    const region = regionFor(log, {
      usSheetId: this.cfg.conquestSheetId,
      ukSheetId: this.cfg.ukSheetId,
    });
    const vars = buildSequenceVars(row, log, region);
    const emails = loadSequence(key);
    for (let step = Math.max(1, fromStep); step <= SEQUENCE_LENGTH; step++) {
      const rendered = renderSequenceEmail(emails[step - 1]!, vars, region);
      if (rendered) return { ...rendered, step, region };
      this.logger.warn(`Skipping email ${step} of "${key}" for push ${log.id}: missing lead data.`);
    }
    return null;
  }

  // Pushes made before row snapshots existed read the row from the sheet once.
  private async rowFor(log: SheetsPushLog, userId: string): Promise<RowData> {
    if (log.rowData && typeof log.rowData === 'object') return log.rowData as RowData;
    const row = await this.sheets
      .readLeadRow(userId, log.spreadsheetId, log.sheetTitle, log.destinationE164)
      .catch((err: unknown) => {
        this.logger.warn(`Reading the row for push ${log.id} failed: ${(err as Error).message}`);
        return null;
      });
    if (!row) return {};
    await this.prisma.sheetsPushLog
      .update({ where: { id: log.id }, data: { rowData: row as Prisma.InputJsonValue } })
      .catch(() => undefined);
    return row;
  }
}
