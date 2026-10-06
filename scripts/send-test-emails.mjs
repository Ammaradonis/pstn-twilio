/**
 * send-test-emails.mjs
 *
 * Sends real test emails for every sequence (all 12 statuses) × both regions
 * (US / UK) to the addresses listed in RECIPIENTS.  Reads the stored Gmail
 * OAuth refresh token from the DB and auto-refreshes before it expires — no
 * gcloud login or manual token needed.
 *
 * Usage:
 *   node scripts/send-test-emails.mjs
 *   node scripts/send-test-emails.mjs --seq rang-out --step 1
 *   node scripts/send-test-emails.mjs --seq voicemail --region UK --step 3
 *
 * Flags:
 *   --seq <key>        Only send a specific sequence key (e.g. rang-out)
 *   --region <US|UK>   Only send one region
 *   --step <1-6>       Which email in the sequence (default: 1)
 *   --dry-run          Parse and render but do NOT call the Gmail API
 */

import { createDecipheriv } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = join(__dirname, '..');
const require    = createRequire(import.meta.url);

// ── Config ────────────────────────────────────────────────────────────────────

const RECIPIENTS = [
  'thermosites@gmail.com',
  'ammaralkheder2900@gmail.com',
  'ammarkh2900@gmail.com',
  'ajidhb66@gmail.com',
  'aaironmonts@gmail.com',
  'usaammar34@gmail.com',
  'usammar34@gmail.com',
  'ammar100alkheder@gmail.com',
  'ammar.word.alchemy@gmail.com',
  'alkhdRmaMwn45@gmail.com',
  'MOHMMADIsalehAT@gmail.com',
  'tattooedmuseink@gmail.com',
  'alkhederammar147@gmail.com',
  'online.primepulsestore@gmail.com',
  'ecocoffeechain@gmail.com',
  'mervattate@gmail.com',
  'ahmad.taate@gmail.com',
  'kinkedupwebhub@gmail.com',
  'aalkheder94@gmail.com',
];

const US_DEMO   = '(667) 220-6726';
const UK_DEMO   = '02045726501';

// Sample variables per region — all 12 sequence variables filled
const US_VARS = {
  school_name:   'Lone Star BJJ Academy',
  website:       'lonestarkbjj.com',
  rating:        '4.9',
  review_count:  '87',
  category:      'martial arts school',
  street:        'SW 34th Ave',
  city:          'Amarillo',
  state:         'Texas',
  called_number: '(806) 803-9393',
  my_number:     US_DEMO,
  call_time:     '6:42pm on Tuesday',
  call_note:     'A kid picked up, said hold on, and I waited almost 2 minutes before it cut off.',
};

const UK_VARS = {
  school_name:   'Neon Martial Arts',
  website:       'neonmartialarts.com',
  rating:        '5',
  review_count:  '57',
  category:      'martial arts school',
  street:        'Green Ln',
  city:          'Southampton',
  state:         'Southampton',
  called_number: '07448999008',
  my_number:     UK_DEMO,
  call_time:     '10:28am on Monday',
  call_note:     'The line connected but nobody said anything for about 30 seconds before it dropped.',
};

const ALL_SEQUENCES = [
  'rang-out',
  'voicemail-not-set-up',
  'line-busy',
  'voicemail',
  'hung-up',
  'not-interested',
  'answering-service',
  'out-of-service',
  'has-receptionist',
  'has-ai',
  'voicemail-full',
  'stayed-silent',
];

// ── CLI ───────────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const flag    = n => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : null; };
const has     = n => args.includes(n);

const seqFilter    = flag('--seq');
const regionFilter = flag('--region')?.toUpperCase();
const stepArg      = parseInt(flag('--step') || '1', 10);
const dryRun       = has('--dry-run');

const sequences = seqFilter ? [seqFilter] : ALL_SEQUENCES;
const regions   = regionFilter ? [regionFilter] : ['US', 'UK'];

// ── .env loader ───────────────────────────────────────────────────────────────

function loadDotEnv(...paths) {
  for (const p of paths) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line.trim());
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  }
}

// ── Decrypt (same as common/secret-box.ts) ───────────────────────────────────
// Format: "v1.<iv base64url>.<tag base64url>.<ciphertext base64url>"

function decryptSecret(sealed, keyB64) {
  const parts = sealed.split('.');
  if (parts.length < 4 || parts[0] !== 'v1') throw new Error('Unrecognized secret format');
  const [, ivPart, tagPart, ...ctParts] = parts;
  const key = Buffer.from(keyB64, 'base64');
  const iv  = Buffer.from(ivPart,  'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  const ct  = Buffer.from(ctParts.join('.'), 'base64url');
  const d   = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

// ── Token manager (auto-refresh, keeps token alive for long runs) ─────────────

const tokenState = {
  refreshToken: null,
  clientId:     null,
  clientSecret: null,
  accessToken:  null,
  expiresAt:    0,
};

async function refreshToken() {
  const { refreshToken: rt, clientId, clientSecret } = tokenState;
  if (!rt || !clientId || !clientSecret) throw new Error('Token state not initialized');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      grant_type:    'refresh_token',
      refresh_token: rt,
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) {
    throw new Error(`Token refresh failed: ${json.error}: ${json.error_description}`);
  }
  tokenState.accessToken = json.access_token;
  // Google access tokens last 3600 s; renew 3 minutes early
  tokenState.expiresAt = Date.now() + (Number(json.expires_in ?? 3599) - 180) * 1000;
  return json.access_token;
}

async function getToken() {
  if (tokenState.accessToken && Date.now() < tokenState.expiresAt) return tokenState.accessToken;
  if (tokenState.refreshToken) return refreshToken();

  loadDotEnv(join(REPO_ROOT, 'apps', 'api', '.env'), join(REPO_ROOT, '.env'));

  const clientId  = process.env.GOOGLE_CLOUD_CLIENT_ID;
  const clientSec = process.env.GOOGLE_CLOUD_CLIENT_SECRET;

  // Fast path 1: GMAIL_TOKEN env var (single-use, no auto-refresh)
  if (process.env.GMAIL_TOKEN && !tokenState.accessToken) {
    console.log('Gmail token  : from GMAIL_TOKEN env var (no auto-refresh)');
    tokenState.accessToken = process.env.GMAIL_TOKEN;
    tokenState.expiresAt   = Date.now() + 55 * 60 * 1000; // assume 55 min remaining
    return tokenState.accessToken;
  }

  // Fast path 2: GMAIL_REFRESH_TOKEN env var
  if (process.env.GMAIL_REFRESH_TOKEN && clientId && clientSec) {
    tokenState.refreshToken = process.env.GMAIL_REFRESH_TOKEN;
    tokenState.clientId     = clientId;
    tokenState.clientSecret = clientSec;
    console.log('Gmail token  : refreshing from GMAIL_REFRESH_TOKEN env var');
    return refreshToken();
  }

  // Full path: read encrypted refresh token from DB
  const TOKEN_KEY = process.env.TOKEN_ENCRYPTION_KEY;
  const dbUrl     = process.env.DATABASE_URL;

  if (!TOKEN_KEY || !clientId || !clientSec || !dbUrl) {
    throw new Error(
      'No Gmail token found. Either:\n' +
      '  1. Set $env:GMAIL_TOKEN=<token> (get one from scripts/gmail-auth.mjs)\n' +
      '  2. Set $env:GMAIL_REFRESH_TOKEN=<token> for auto-renewal\n' +
      '  3. Ensure TOKEN_ENCRYPTION_KEY, GOOGLE_CLOUD_CLIENT_ID/SECRET, DATABASE_URL are set\n'
    );
  }

  const { PrismaClient } = require(join(REPO_ROOT, 'apps', 'api', 'node_modules', '@prisma', 'client'));
  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
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
    throw new Error(
      'No GoogleSheetsConnection in DB.\n' +
      'Run: node scripts/gmail-auth.mjs  and follow the steps to get a fresh token.\n'
    );
  }

  for (const row of rows) {
    let rt;
    try { rt = decryptSecret(row.refreshTokenEncrypted, TOKEN_KEY); }
    catch (e) { console.error(`Decrypt failed for ${row.googleEmail}: ${e.message}`); continue; }

    tokenState.refreshToken = rt;
    tokenState.clientId     = clientId;
    tokenState.clientSecret = clientSec;
    console.log(`Gmail account : ${row.googleEmail}`);
    return refreshToken();
  }
  throw new Error(
    'Stored refresh token is revoked or invalid.\n' +
    'Run: node scripts/gmail-auth.mjs  to get a fresh token.\n'
  );
}

// ── Template loader / parser ──────────────────────────────────────────────────

const TEMPLATE_DIRS = [
  join(REPO_ROOT, 'apps', 'api', 'templates', 'sequences'),
  join(REPO_ROOT, 'templates', 'sequences'),
];

function sequenceDir() {
  return TEMPLATE_DIRS.find(d => existsSync(join(d, 'rang-out.txt'))) ?? null;
}

function loadSequence(key) {
  const dir = sequenceDir();
  if (!dir) throw new Error('Cannot find templates/sequences directory.');
  const file = join(dir, `${key}.txt`);
  if (!existsSync(file)) throw new Error(`No template: ${key}.txt`);
  return parseSequence(readFileSync(file, 'utf8'));
}

function parseSequence(raw) {
  const blocks = raw.replace(/\r\n/g, '\n').split(/\n={5,}\n/);
  const emails = [];
  for (const block of blocks) {
    const m = /^\s*EMAIL\s+(\d+)\s*\nSubject:[ \t]*(.*)\n([\s\S]*)$/i.exec(block);
    if (!m) continue;
    emails.push({ step: Number(m[1]), subject: m[2].trim(), body: m[3].trim() });
  }
  return emails.sort((a, b) => a.step - b.step);
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function renderEmail(email, vars, region) {
  const demo = region === 'UK' ? UK_DEMO : US_DEMO;
  // adaptToVars
  let { subject, body } = email;
  if (!vars.street.trim()) {
    const fix = t => t
      .replace(/\bon \{\{street\}\} in \{\{(city|state)\}\}/g, 'in {{$1}}')
      .replace(/\bon \{\{street\}\}/g, 'in {{city}}');
    subject = fix(subject); body = fix(body);
  }
  if (vars.city.trim().toLowerCase() === vars.state.trim().toLowerCase()) {
    const fix = t => t.replace(/\{\{city\}\}(?:,| and) \{\{state\}\}/g, '{{city}}');
    subject = fix(subject); body = fix(body);
  }
  // fill variables then swap demo number
  const fill = text =>
    text
      .replace(/\{\{(\w+)\}\}/g, (_, n) => vars[n]?.trim() ?? '')
      .split(US_DEMO).join(demo);
  return {
    subject: fill(subject).trim(),
    body: fill(body)
      .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim(),
  };
}

// ── Gmail send ────────────────────────────────────────────────────────────────

function encodeMessage(to, subject, body) {
  if (/[\r\n]/.test(to)) throw new Error('Invalid recipient.');
  const msg = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64'),
  ].join('\r\n');
  return Buffer.from(msg).toString('base64url');
}

async function sendEmail(to, subject, body) {
  const token = await getToken();
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encodeMessage(to, subject, body) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gmail send failed: ${json?.error?.message ?? `HTTP ${res.status}`}`);
  return json.id ?? '(no id)';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Email Sequence Test Sender ===`);
  console.log(`Sequences : ${sequences.join(', ')}`);
  console.log(`Regions   : ${regions.join(', ')}`);
  console.log(`Step      : ${stepArg}`);
  console.log(`Dry run   : ${dryRun}`);
  console.log(`Recipients: ${RECIPIENTS.length}\n`);

  if (!dryRun) {
    const token = await getToken();
    console.log(`Token     : ${token.slice(0, 30)}…\n`);
  }

  let totalSent = 0, totalFailed = 0, totalSkipped = 0;

  for (const seqKey of sequences) {
    let emails;
    try { emails = loadSequence(seqKey); }
    catch (err) { console.error(`[SKIP] ${seqKey}: ${err.message}`); totalSkipped++; continue; }

    const step = Math.min(stepArg, emails.length);
    const template = emails[step - 1];
    if (!template) { console.error(`[SKIP] ${seqKey}: no email ${step}`); totalSkipped++; continue; }

    for (const region of regions) {
      const vars = region === 'UK' ? UK_VARS : US_VARS;
      const { subject, body } = renderEmail(template, vars, region);
      const testSubject = `[TEST ${region} / ${seqKey} / email ${step}] ${subject}`;

      console.log(`\n── ${seqKey}  |  region=${region}  |  step=${step}`);
      console.log(`   Subject : ${subject}`);
      console.log(`   Demo#   : ${region === 'UK' ? UK_DEMO : US_DEMO}`);
      if (dryRun) console.log(`   Body:\n${body.slice(0, 250)}\n   …`);

      for (const to of RECIPIENTS) {
        if (dryRun) { console.log(`   [DRY-RUN] → ${to}`); continue; }
        try {
          const id = await sendEmail(to, testSubject, body);
          console.log(`   ✓ ${to}  (id: ${id})`);
          totalSent++;
        } catch (err) {
          console.error(`   ✗ ${to}: ${err.message}`);
          totalFailed++;
        }
        // 800 ms between sends — conservative to avoid rate limit
        await new Promise(r => setTimeout(r, 800));
      }
    }
  }

  console.log(`\n=== Done: ${totalSent} sent, ${totalFailed} failed, ${totalSkipped} skipped ===\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
