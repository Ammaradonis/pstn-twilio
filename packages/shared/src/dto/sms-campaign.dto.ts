// The cold SMS campaign: one text per called lead, sent from the toll-free
// number. The rules are fixed here so the API and the page agree on them.

import type { MessageStatus } from '../types/index';

/** Most campaign texts in any 24 hours. */
export const SMS_CAMPAIGN_DAILY_CAP = 100;
/** The toll-free line the texts come from. */
export const SMS_CAMPAIGN_FROM_E164 = '+18776524532';
/** Local hours in the lead's time zone when texts may go out: 9am up to 8pm, every day. */
export const SMS_CAMPAIGN_HOURS = { start: 9, end: 20 } as const;
/** Minutes between two texts, so a day's texts are spread out instead of sent in a burst. */
export const SMS_CAMPAIGN_SEND_GAP_MINUTES = 5;

export const SMS_CAMPAIGN_LOOM_URL = 'https://www.loom.com/share/a3614b444000454daebb01634bc47711';

/** The text as written for the campaign. {{school_name}} is the school's name, or "there". */
export const DEFAULT_SMS_CAMPAIGN_BODY = [
  'Hey {{school_name}}, Ammar here. I called your school recently and recorded a short video for owners like you about the calls that slip away while your on the mat:',
  SMS_CAMPAIGN_LOOM_URL,
  'Rather spar than watch? Call my AI front desk at (667) 220-6726, ask to book a trial and try to make it tap out.',
  'Reply STOP to opt out',
].join('\n');

/**
 * SENDING: handed to Twilio, waiting for its answer. SENT: Twilio took it (the
 * delivery result is on the message). FAILED: Twilio refused it for this
 * number. OPTED_OUT: the number texted STOP to the line at some point.
 */
export type SmsCampaignSendStatus = 'SENDING' | 'SENT' | 'FAILED' | 'OPTED_OUT';

export interface SmsCampaignSendDto {
  id: string;
  to: string;
  schoolName: string | null;
  status: SmsCampaignSendStatus;
  /** Twilio's delivery status once the text was taken; null before that. */
  delivery: MessageStatus | null;
  /** Why it failed or was not delivered. */
  error: string | null;
  sentAt: string;
}

export interface SmsCampaignDto {
  enabled: boolean;
  body: string;
  dailyCap: number;
  from: string;
  /** Texts taken by Twilio in the last 24 hours (counts against dailyCap). */
  sentLast24h: number;
  /** Leads that can still get a text. */
  waiting: number;
  totals: {
    sent: number;
    delivered: number;
    /** Taken by Twilio but not delivered (landline, filtered, unreachable). */
    undelivered: number;
    /** Refused by Twilio for that number. */
    failed: number;
    optedOut: number;
  };
  /** Why the last send attempt didn't go out, or why the campaign paused itself. */
  lastError: string | null;
  lastSendAt: string | null;
  recent: SmsCampaignSendDto[];
}

export interface SmsCampaignTestResultDto {
  to: string;
  body: string;
}
