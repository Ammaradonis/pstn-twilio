const E164_RE = /^\+[1-9]\d{1,14}$/;
const EXTENSION_RE = /\s*(?:[,;#]\s*)?(?:ext\.?|extension|x|#)\s*\d{1,6}\s*$/i;
const UNICODE_DASH_RE = /[\u2010-\u2015\u2212]/g;
const UNICODE_PLUS_RE = /[\uFF0B]/g;
const PHONE_SEPARATOR = String.raw`[\s,./'"’‘()\-]*`;
const INTERNATIONAL_PHONE_CANDIDATE_RE = new RegExp(
  String.raw`(?:^|[^\d+])(\+(?:${PHONE_SEPARATOR}\d){2,15}(?:\s*(?:ext\.?|extension|x|#)\s*\d{1,6})?)(?=$|[^\d])`,
  'gi',
);
const US_PHONE_CANDIDATE_RE = new RegExp(
  String.raw`(?:^|[^\d+])((?:\+?1${PHONE_SEPARATOR})?(?:\([2-9]\d{2}\)|[2-9]\d{2})${PHONE_SEPARATOR}[2-9]\d{2}${PHONE_SEPARATOR}\d{4}(?:\s*(?:ext\.?|extension|x|#)\s*\d{1,6})?)(?=$|[^\d])`,
  'gi',
);

function normalizeSeparators(value: string): string {
  return value.normalize('NFKC').replace(UNICODE_DASH_RE, '-').replace(UNICODE_PLUS_RE, '+');
}

function normalizeInternationalCandidate(candidate: string): string | null {
  const stripped = candidate.replace(EXTENSION_RE, '').trim();
  if (!stripped.startsWith('+')) return null;

  const digits = stripped.slice(1).replace(/\D/g, '');
  if (!/^[1-9]\d{1,14}$/.test(digits)) return null;
  return `+${digits}`;
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

  for (const match of input.matchAll(INTERNATIONAL_PHONE_CANDIDATE_RE)) {
    const candidate = match[1];
    if (!candidate) continue;
    const normalized = normalizeInternationalCandidate(candidate);
    if (normalized) return normalized;
  }

  for (const match of input.matchAll(US_PHONE_CANDIDATE_RE)) {
    const candidate = match[1];
    if (!candidate) continue;
    const normalized = normalizeUsCandidate(candidate);
    if (normalized) return normalized;
  }

  return null;
}
