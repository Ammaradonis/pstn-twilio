/**
 * gmail-auth.mjs
 *
 * One-time OAuth flow to get a Gmail send-scoped token using the app's own
 * OAuth client (GOOGLE_CLOUD_CLIENT_ID from .env).
 *
 * Step 1: Run this script — it prints a URL to open in your browser.
 * Step 2: Paste the authorization code it gives you back into the prompt.
 * Step 3: The script prints GMAIL_TOKEN=<access_token> and GMAIL_REFRESH=<refresh_token>.
 *
 * The access token goes into the GMAIL_TOKEN env var for send-test-emails.mjs,
 * OR the refresh token can be set as GMAIL_REFRESH_TOKEN for auto-renewal.
 *
 * Usage:
 *   node scripts/gmail-auth.mjs
 *   $env:GMAIL_TOKEN = "ya29..."; node scripts/send-test-emails.mjs --step 1
 */

import { createInterface } from 'readline';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

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

const CLIENT_ID     = process.env.GOOGLE_CLOUD_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLOUD_CLIENT_SECRET;
const REDIRECT_URI  = 'urn:ietf:wg:oauth:2.0:oob';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('GOOGLE_CLOUD_CLIENT_ID or GOOGLE_CLOUD_CLIENT_SECRET not set in .env');
  process.exit(1);
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'openid',
  'email',
].join(' ');

const url = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
  client_id:    CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  response_type: 'code',
  scope:        SCOPES,
  access_type:  'offline',
  prompt:       'consent',
}).toString();

console.log('\n=== Gmail OAuth — one-time setup ===\n');
console.log('1. Open this URL in your browser (make sure you\'re signed in as ammar.webalchemist@gmail.com):');
console.log('\n' + url + '\n');
console.log('2. Click Allow, then copy the code shown.');

const rl = createInterface({ input: process.stdin, output: process.stdout });
rl.question('\nPaste the code here: ', async (code) => {
  rl.close();
  code = code.trim();
  if (!code) { console.error('No code entered.'); process.exit(1); }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type:    'authorization_code',
      code,
      redirect_uri:  REDIRECT_URI,
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    console.error('Token exchange failed:', json.error, json.error_description);
    process.exit(1);
  }

  console.log('\n=== Tokens ===');
  console.log(`\nAccess token (use for --one-off, expires in ~1h):`);
  console.log(`  $env:GMAIL_TOKEN="${json.access_token}"`);
  if (json.refresh_token) {
    console.log(`\nRefresh token (save for auto-renewal):`);
    console.log(`  $env:GMAIL_REFRESH_TOKEN="${json.refresh_token}"`);
  }
  console.log(`\nRun test emails:`);
  console.log(`  $env:GMAIL_TOKEN="${json.access_token}"; node scripts/send-test-emails.mjs --step 1`);
  console.log('');
});
