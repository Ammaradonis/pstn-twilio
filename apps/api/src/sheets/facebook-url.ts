/**
 * Identity helpers for Facebook page URLs and school names.
 *
 * The worker (workers/meta-ads/matching.py) and the Sheets bridge both need the
 * same answer to "is this the same Facebook page?" — a school that is linked as
 * https://www.facebook.com/SomeSchool/?ref=page_internal must match the ad
 * card's https://www.facebook.com/someschool. Tracking parameters, mobile hosts,
 * trailing slashes and numeric profile URLs are all normalized here.
 *
 * Anything ambiguous (a bare /people/… without an ID, a short link, a non-Facebook
 * host) returns '' so the caller can require a human, never a guess.
 */

const FACEBOOK_HOSTS = new Set([
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'mbasic.facebook.com',
]);

// Paths that are not a page identity.
const RESERVED_PATHS = new Set([
  'ads',
  'login',
  'groups',
  'watch',
  'share',
  'help',
  'reel',
  'photo.php',
  'profile.php',
  'home.php',
  'settings',
  'marketplace',
  'events',
  'gaming',
  'l.php',
]);

/**
 * Normalized page identity: `name:<slug>` for a vanity URL, `id:<digits>` for a
 * numeric profile or a `/people/<name>/<id>` URL, and '' when it is not a page.
 */
export function facebookKey(raw: string): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  try {
    const u = new URL(value.includes('://') ? value : `https://${value}`);
    if (!FACEBOOK_HOSTS.has(u.hostname.toLowerCase())) return '';
    const parts = u.pathname
      .split('/')
      .filter(Boolean)
      .map((p) => decodeURIComponent(p).toLowerCase());
    if (parts.length === 1 && parts[0] === 'profile.php') {
      const id = u.searchParams.get('id') ?? '';
      return /^\d+$/.test(id) ? `id:${id}` : '';
    }
    if (parts.length === 3 && ['people', 'pages'].includes(parts[0]!) && /^\d+$/.test(parts[2]!))
      return `id:${parts[2]}`;
    if (parts.length === 1 && !RESERVED_PATHS.has(parts[0]!))
      return `${/^\d+$/.test(parts[0]!) ? 'id' : 'name'}:${parts[0]}`;
  } catch {
    /* Unrecognized profile: the caller asks for review instead of guessing. */
  }
  return '';
}

/**
 * School names compared the way the worker compares them: NFKC, lowercase, "&"
 * read as "and", punctuation dropped, whitespace collapsed. "St. Mary's Jujitsu
 * Academy" and "St Marys Jujitsu Academy" compare equal.
 */
export function nameKey(value: string): string {
  return (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}_\s]/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** The pair that must both agree before a row is treated as the same school. */
export function schoolKey(title: string, facebookUrl: string): string {
  return `${nameKey(title)}\u0000${facebookKey(facebookUrl)}`;
}
