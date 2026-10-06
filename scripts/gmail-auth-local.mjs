/**
 * gmail-auth-local.mjs
 *
 * Spins up a tiny HTTP server on localhost:9999, prints a URL to open in
 * your browser, catches the OAuth callback, exchanges the code for tokens,
 * then prints the access + refresh tokens and exits.
 *
 * Requirements: localhost:9999 must be added as an authorised redirect URI
 * in the Google Cloud Console for client 569386835903.
 *
 * If that console isn't accessible, this script also tries the app's own
 * registered redirect  (https://api.bestsoftphone.site/…) via a local proxy
 * that you manually paste the code from.
 *
 * Usage:  node scripts/gmail-auth-local.mjs
 */

import { createServer } from 'http';
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
const PORT          = 9999;
const REDIRECT_URI  = `http://localhost:${PORT}/callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('GOOGLE_CLOUD_CLIENT_ID or GOOGLE_CLOUD_CLIENT_SECRET not set');
  process.exit(1);
}

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.metadata.readonly',
  'openid',
  'email',
].join(' ');

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id:     CLIENT_ID,
  redirect_uri:  REDIRECT_URI,
  response_type: 'code',
  scope:         SCOPES,
  access_type:   'offline',
  prompt:        'consent',
}).toString();

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith('/callback')) {
    res.writeHead(404); res.end(); return;
  }
  const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
  const code  = params.get('code');
  const error = params.get('error');

  if (error || !code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end(`<h1>Error: ${error ?? 'no code'}</h1>`);
    server.close();
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<h1>Got it! You can close this tab.</h1><p>Check the terminal for your tokens.</p>');

  // Exchange code for tokens
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
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
  const json = await tokenRes.json();
  server.close();

  if (!tokenRes.ok || !json.access_token) {
    console.error('\nToken exchange failed:', json.error, '-', json.error_description);
    process.exit(1);
  }

  console.log('\n✓ Tokens obtained!\n');
  console.log('Access token  (expires ~1h):');
  console.log(json.access_token);
  if (json.refresh_token) {
    console.log('\nRefresh token (save this — does not expire):');
    console.log(json.refresh_token);
    console.log('\nTo run all test emails with auto-refresh:');
    console.log(`  $env:GMAIL_REFRESH_TOKEN="${json.refresh_token}"; node scripts/send-test-emails.mjs --step 1`);
  } else {
    console.log('\nTo run all test emails (single-use token):');
    console.log(`  $env:GMAIL_TOKEN="${json.access_token}"; node scripts/send-test-emails.mjs --step 1`);
  }
  console.log('');
}).listen(PORT, () => {
  console.log('\n=== Gmail OAuth — local flow ===');
  console.log(`\nListening on http://localhost:${PORT}`);
  console.log('\nOpen this URL in your browser:');
  console.log('\n' + authUrl + '\n');
  console.log('Waiting for the OAuth callback...\n');
});

server.on('error', err => {
  console.error('Server error:', err.message);
  process.exit(1);
});
