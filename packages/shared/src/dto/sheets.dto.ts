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

// MANUAL: no email, so the follow-up waits for the user to send it through the school's contact form.
export type SheetsEmailStatus =
  | 'NONE'
  | 'PENDING'
  | 'WAITING_RESEARCH'
  | 'FORM_PREPARING'
  | 'FORM_SENDING'
  | 'SENDING'
  | 'SENT'
  | 'FAILED'
  | 'CANCELLED'
  | 'MANUAL'
  // The lead wrote back, so the rest of the sequence was not sent.
  | 'REPLIED';

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
  // Which of the sequence's 6 emails is next (or the last one, once finished).
  sequenceStep: number;
  emailDueAt: string | null;
  emailSentAt: string | null;
  emailError: string | null;
  contactFormUrl: string | null;
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

/** A follow-up rendered for sending by hand through a contact form. */
export interface SheetsFollowUpMessageDto {
  subject: string;
  body: string;
  contactFormUrl: string | null;
}

// ── Email finder ──────────────────────────────────────────────────────────────

export type EmailFinderJobStatus = 'RUNNING' | 'PAUSED' | 'DONE' | 'CANCELLED';

/** One address the email finder found, as shown in the Dial page notifications. */
export interface EmailFinderFindDto {
  /** The finder row; stable across the realtime event and the status poll. */
  rowId: string;
  jobId: string;
  spreadsheetId: string;
  sheetTitle: string;
  school: string;
  email: string;
  emailType: string | null;
  confidence: number | null;
  /** How it was found, e.g. "Facebook contact info via iPhone emulation". */
  method: string | null;
  sourceUrl: string | null;
  foundAt: string;
}

export interface EmailFinderStatusDto {
  jobId: string | null;
  status: EmailFinderJobStatus | null;
  /** Rows queued for this tab (rows that already had an email are skipped). */
  total: number;
  /** Rows the finder has finished. */
  done: number;
  found: number;
  contactForms: number;
  /** Rows that already had an email when the tab was queued. */
  alreadyHadEmail: number;
  /** The worker on the user's PC checked in during the last 2 minutes. */
  workerOnline: boolean;
  workerLastSeen: string | null;
  retrying?: number;
  failed?: number;
  issues?: { school: string; note: string }[];
  /** The tab's latest finds, newest first. */
  recentFinds?: EmailFinderFindDto[];
}
