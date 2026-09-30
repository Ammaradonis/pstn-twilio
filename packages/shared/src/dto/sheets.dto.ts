import type { CallStatusTag } from '../types/call-status-tags';

/** One spreadsheet the Google account can open. */
export interface SheetsSpreadsheetDto {
  spreadsheetId: string;
  name: string;
}

/** One tab (sheet) inside a spreadsheet. */
export interface SheetTabDto {
  sheetId: number;
  title: string;
}

/** Sent from the Dial page after a call ends. */
export interface PushCallResultDto {
  spreadsheetId: string;
  sheetTitle: string;
  /** Tags in selection order (first = picks the follow-up email template). */
  orderedTags: CallStatusTag[];
  /** Custom explanation: written into the cell and available to the email. */
  customNote?: string;
  /** E.164 of the number that was dialled. */
  destinationE164: string;
  /** E.164 caller ID used for the call. */
  callerE164: string;
  /** ISO-8601 time the call ended (taken at hangup). */
  callEndedAt: string;
}

export type SheetsTimeZoneSource = 'uk' | 'zip' | 'city' | 'state' | 'guess';

export type SheetsEmailStatus = 'NONE' | 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'CANCELLED';

/** Response from the push endpoint. */
export interface SheetsStatusDto {
  spreadsheetId: string;
  sheetTitle: string;
  /** 1-based row that was written. */
  rowIndex: number;
  /** Other rows with the same phone number (not written). */
  duplicateRows: number[];
  /** Exact text written to the Status cell. */
  cellValue: string;
  timeZone: string;
  timeZoneSource: SheetsTimeZoneSource;
  emailStatus: SheetsEmailStatus;
  emailTo: string | null;
  emailTemplate: string | null;
  emailDueAt: string | null;
  /** Why no email was scheduled, when emailStatus is NONE. */
  emailNote: string | null;
}

export interface SheetsConnectionStatusDto {
  connected: boolean;
  email: string | null;
  configured: boolean;
  /** API settings still to be set (e.g. GOOGLE_CLOUD_CLIENT_SECRET). */
  missing: string[];
}

export interface SheetsFollowUpDto {
  id: string;
  destinationE164: string;
  sheetTitle: string;
  rowIndex: number;
  emailTo: string | null;
  emailTemplate: string | null;
  emailStatus: SheetsEmailStatus;
  emailDueAt: string | null;
  emailSentAt: string | null;
  emailError: string | null;
}

/** Result of checking the "U.S. Conquest" addresses against the time zone resolver. */
export interface SheetsTimeZoneCheckDto {
  tabs: number;
  addresses: number;
  bySource: Record<SheetsTimeZoneSource | 'none', number>;
  /** City → time zone pairs learned from addresses that carry a ZIP code. */
  learnedCities: number;
  /** Addresses in split-zone states that could only be guessed (first 50). */
  uncertain: { tab: string; row: number; address: string; timeZone: string }[];
}
