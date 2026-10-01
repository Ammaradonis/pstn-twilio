// All selectable status tags for the post-call panel, in display order.
// The labels are written into the sheet's Status cell as-is.
export const CALL_STATUS_TAGS = [
  'Rang out',
  "Rang out but voicemail box hasn't been set up yet",
  'Line is busy',
  'Voicemail',
  'Hung up on me',
  'Not interested',
  'Has an answering service',
  'Out-of-service number',
  'Not available',
  'Has a receptionist',
  'Has an AI',
  'Handles calls himself',
  'Voicemail is full',
  'Booked a demo',
  'Stayed silent',
] as const;

export type CallStatusTag = (typeof CALL_STATUS_TAGS)[number];

// Tags that send a follow-up cold email 48 hours after the call, mapped to the
// template file (apps/api/templates/cold-email/<name>.txt).
export const TAG_EMAIL_TEMPLATE: Partial<Record<CallStatusTag, string>> = {
  'Rang out': 'rang-out',
  "Rang out but voicemail box hasn't been set up yet": 'voicemail-not-set-up',
  'Line is busy': 'line-busy',
  Voicemail: 'voicemail',
  'Hung up on me': 'hung-up',
  'Not interested': 'not-interested',
  'Has an answering service': 'answering-service',
  'Out-of-service number': 'out-of-service',
  'Has a receptionist': 'has-receptionist',
  'Has an AI': 'has-ai',
  'Voicemail is full': 'voicemail-full',
  'Stayed silent': 'stayed-silent',
};

export function isCallStatusTag(value: unknown): value is CallStatusTag {
  return typeof value === 'string' && (CALL_STATUS_TAGS as readonly string[]).includes(value);
}

export type FollowUpDecision =
  | { template: string; tag: CallStatusTag }
  | { template: null; reason: string };

// Tags are ordered by when they were (last) selected. The first selected tag
// that sends email picks the template; tags that don't send email are skipped
// over, and "Booked a demo" anywhere in the selection means no cold email.
export function pickFollowUpTemplate(orderedTags: readonly CallStatusTag[]): FollowUpDecision {
  if (orderedTags.includes('Booked a demo')) {
    return { template: null, reason: 'Booked a demo — no follow-up email.' };
  }
  for (const tag of orderedTags) {
    const template = TAG_EMAIL_TEMPLATE[tag];
    if (template) return { template, tag };
  }
  return { template: null, reason: 'None of the selected statuses sends a follow-up email.' };
}
