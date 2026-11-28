// Numbers that take no incoming calls or texts. Incoming calls get a busy
// signal and are not logged, and incoming texts are dropped without being
// stored or shown. Calls and texts sent *from* these numbers are unaffected.
export const INBOUND_BLOCKED_NUMBERS: ReadonlySet<string> = new Set(['+18776524532']);

export function isInboundBlocked(to: string | null | undefined): boolean {
  return Boolean(to) && INBOUND_BLOCKED_NUMBERS.has(to!);
}
