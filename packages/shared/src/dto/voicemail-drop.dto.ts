// The message the Dial page's "Drop voicemail" button leaves on a live call.

/** Longest message that can be saved: most voicemail boxes stop at 2-3 minutes. */
export const VOICEMAIL_DROP_MAX_MS = 120_000;

export interface VoicemailDropDto {
  durationMs: number;
  updatedAt: string;
}

export interface VoicemailDropResultDto {
  /** The callee's leg, now playing the message instead of talking to the browser. */
  calleeCallSid: string;
  durationMs: number;
}
