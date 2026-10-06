/**
 * get-gmail-token.mjs
 *
 * Reads the encrypted Gmail refresh token stored in the DB by the app,
 * decrypts it using the same AES-256-GCM scheme as secret-box.ts, then
 * exchanges it for a fresh access token via the Google OAuth2 token endpoint.
 *
 * Prints:  GMAIL_TOKEN=<token>   on stdout.
 *
 * Usage:  node scripts/get-gmail-token.mjs
 */
import { createDecipheriv } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// ── Load .env ─────────────────────────────────────────────────────────────────
function loadDotEnv(...paths) {
  for (const p of paths) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
}
loadDotEnv(join(ROOT, 'apps', 'api', '.env'), join(ROOT, '.env'));

const TOKEN_KEY     = process.env.TOKEN_ENCRYPTION_KEY;
const CLIENT_ID     = process.env.GOOGLE_CLOUD_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLOUD_CLIENT_SECRET;

if (!TOKEN_KEY)     { console.error('TOKEN_ENCRYPTION_KEY not set'); process.exit(1); }
if (!CLIENT_ID)     { console.error('GOOGLE_CLOUD_CLIENT_ID not set'); process.exit(1); }
if (!CLIENT_SECRET) { console.error('GOOGLE_CLOUD_CLIENT_SECRET not set'); process.exit(1); }

// ── secret-box decrypt (matches apps/api/src/common/secret-box.ts) ─────────────
// Format: "v1.<iv base64url>.<tag base64url>.<ciphertext base64url>"
function decryptSecret(sealed, keyB64) {
  const parts = sealed.split('.');
  if (parts.length < 4 || parts[0] !== 'v1') throw new Error(`Unrecognized secret format (parts=${parts.length}): ${sealed.slice(0, 30)}`);
  const [, ivPart, tagPart, ...ctParts] = parts;
  const ciphertextPart = ctParts.join('.'); // in case ciphertext itself had dots
  const key    = Buffer.from(keyB64, 'base64');
  const iv     = Buffer.from(ivPart, 'base64url');
  const tag    = Buffer.from(tagPart, 'base64url');
  const ct     = Buffer.from(ciphertextPart, 'base64url');
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// ── Prisma query ──────────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
const prismaClientPath = join(ROOT, 'apps', 'api', 'node_modules', '@prisma', 'client');

let PrismaClient;
try {
  PrismaClient = require(prismaClientPath).PrismaClient;
} catch (e) {
  console.error('Cannot load @prisma/client from apps/api/node_modules:', e.message);
  process.exit(1);
}

const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('DATABASE_URL not set'); process.exit(1); }

async function main() {
  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let rows;
  try {
    rows = await prisma.googleSheetsConnection.findMany({
      select: { googleEmail: true, refreshTokenEncrypted: true },
      take: 5,
    });
  } finally {
    await prisma.$disconnect();
  }

  if (!rows.length) {
    console.error('No GoogleSheetsConnection rows in DB. Connect via the app settings first.');
    process.exit(1);
  }

  for (const row of rows) {
    console.error(`Found connection: ${row.googleEmail}`);
    let refreshToken;
    try {
      refreshToken = decryptSecret(row.refreshTokenEncrypted, TOKEN_KEY);
    } catch (e) {
      console.error(`  Decrypt failed: ${e.message}`);
      continue;
    }

    // Exchange for access token
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    const json = await res.json();
    if (!res.ok || !json.access_token) {
      console.error(`  Token refresh failed: ${json.error}: ${json.error_description}`);
      continue;
    }
    // Print just the token on stdout so it can be captured
    console.log(json.access_token);
    console.error(`  Scopes: ${json.scope ?? '(not returned in refresh response)'}`);
    return;
  }
  console.error('Could not get a working Gmail token from any stored connection.');
  process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
