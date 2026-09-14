import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'crypto';

// AES-256-GCM for secrets stored at rest (e.g. OAuth refresh tokens).
// `key` is 32 bytes, base64 encoded. Output: v1.<iv>.<tag>.<ciphertext>, base64url.

function keyBytes(key: string): Buffer {
  const bytes = Buffer.from(key, 'base64');
  if (bytes.length !== 32) throw new Error('Encryption key must be 32 bytes, base64 encoded');
  return bytes;
}

export function encryptSecret(plaintext: string, key: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv, tag, ciphertext]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function decryptSecret(sealed: string, key: string): string {
  const [version, iv, tag, ciphertext] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || !ciphertext) throw new Error('Unrecognized secret format');
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

// Compact signed payload for OAuth `state`: <base64url json>.<hmac>.
export function signPayload(payload: object, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifySignedPayload<T>(token: string, secret: string): T | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  const actual = Buffer.from(mac, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
