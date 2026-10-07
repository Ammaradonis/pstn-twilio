// Whether answered incoming calls to a number are recorded. The browser that
// answers records them (free); Twilio only steps in when that browser cannot.
// On unless turned off. A new tag: the old `recordInboundCalls` meant "Twilio
// records", and a number switched off to save Twilio fees is not an opt-out
// of free browser recording.
export const RECORD_INBOUND_TAG = 'recordInboundInBrowser';

export function recordsInboundCalls(tags: unknown): boolean {
  return (tags as Record<string, unknown> | null)?.[RECORD_INBOUND_TAG] !== false;
}
