const E164_RE = /^\+[1-9]\d{1,14}$/;
const EXTENSION_RE = /\s*(?:ext\.?|extension|x)\s*\d{1,6}\s*$/i;
const UNICODE_DASH_RE = /[\u2010-\u2015\u2212]/g;

function normalizeSeparators(value: string): string {
  return value.replace(UNICODE_DASH_RE, '-');
}

function normalizeUsCandidate(candidate: string): string | null {
  const digits = candidate.replace(EXTENSION_RE, '').replace(/\D/g, '');
  const nationalNumber =
    digits.length === 11 && digits.startsWith('1')
      ? digits.slice(1)
      : digits.length === 10
        ? digits
        : null;

  if (!nationalNumber || !/^[2-9]\d{2}[2-9]\d{6}$/.test(nationalNumber)) {
    return null;
  }

  return `+1${nationalNumber}`;
}

export function normalizeDialablePhoneNumber(value: string): string | null {
  const input = normalizeSeparators(value.trim());
  if (!input) return null;
  if (E164_RE.test(input)) return input;

  const usPhoneCandidateRe =
    /(?:^|[^\d+])((?:\+?1[\s.-]*)?(?:\([2-9]\d{2}\)|[2-9]\d{2})[\s.-]*[2-9]\d{2}[\s.-]*\d{4}(?:\s*(?:ext\.?|extension|x)\s*\d{1,6})?)(?=$|[^\d])/gi;

  for (const match of input.matchAll(usPhoneCandidateRe)) {
    const candidate = match[1];
    if (!candidate) continue;
    const normalized = normalizeUsCandidate(candidate);
    if (normalized) return normalized;
  }

  return null;
}
