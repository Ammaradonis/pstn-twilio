/**
 * apps/api/scripts/vapi-sync.ts
 *
 * Pushes the consultation-booking assistant to Vapi and points the outbound
 * phone number (the 667 line) at the API so callbacks reach the agent.
 * Afterwards it reads both back from Vapi and checks they match.
 *
 * Usage (from repo root):
 *   npx tsx apps/api/scripts/vapi-sync.ts            # apply, then verify
 *   npx tsx apps/api/scripts/vapi-sync.ts --verify   # verify only, no writes
 *
 * Required env: VAPI_PRIVATE_KEY, VAPI_PHONE_NUMBER_ID, VAPI_WEBHOOK_SECRET,
 * and TWILIO_WEBHOOK_BASE_URL (or PUBLIC_BASE_URL): the API's public base URL.
 * Prints the assistant id to set as VAPI_ASSISTANT_ID on the API.
 */

import {
  CONSULT_BOOKER_ASSISTANT_NAME,
  buildConsultBookerAssistant,
} from '../src/ai-calls/consult-booker.assistant';

const VAPI = 'https://api.vapi.ai';

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return value;
}

async function vapi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${VAPI}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${requireEnv('VAPI_PRIVATE_KEY')}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(
      `${method} ${path} -> ${res.status}: ${JSON.stringify(parsed?.message ?? parsed)}`,
    );
  }
  return parsed as T;
}

type Json = Record<string, unknown>;

function check(label: string, ok: boolean, failures: string[]): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
}

async function main(): Promise<void> {
  const verifyOnly = process.argv.includes('--verify');
  const baseUrl = (
    process.env.TWILIO_WEBHOOK_BASE_URL ??
    process.env.PUBLIC_BASE_URL ??
    ''
  ).replace(/\/$/, '');
  if (!baseUrl.startsWith('https://')) {
    console.error(
      "TWILIO_WEBHOOK_BASE_URL (or PUBLIC_BASE_URL) must be the API's public https URL",
    );
    process.exit(1);
  }
  const webhookUrl = `${baseUrl}/webhooks/vapi`;
  const webhookSecret = requireEnv('VAPI_WEBHOOK_SECRET');
  const phoneNumberId = requireEnv('VAPI_PHONE_NUMBER_ID');
  const desired = buildConsultBookerAssistant({ webhookUrl, webhookSecret });

  const assistants = await vapi<Json[]>('GET', '/assistant?limit=1000');
  let assistant = assistants.find((a) => a.name === CONSULT_BOOKER_ASSISTANT_NAME);

  if (!verifyOnly) {
    assistant = assistant
      ? await vapi<Json>('PATCH', `/assistant/${assistant.id}`, desired)
      : await vapi<Json>('POST', '/assistant', desired);
    console.log(`Assistant ${assistant.id} saved.`);

    await vapi<Json>('PATCH', `/phone-number/${phoneNumberId}`, {
      assistantId: null,
      server: { url: webhookUrl, headers: { 'x-vapi-secret': webhookSecret }, timeoutSeconds: 20 },
    });
    console.log(`Phone number ${phoneNumberId} now asks the API which assistant answers.`);
  }

  if (!assistant) {
    console.error(
      `No assistant named "${CONSULT_BOOKER_ASSISTANT_NAME}" exists yet. Run without --verify.`,
    );
    process.exit(1);
  }

  // Read back from Vapi and compare.
  const failures: string[] = [];
  const live = await vapi<Json>('GET', `/assistant/${assistant.id}`);
  const liveModel = live.model as Json;
  const liveTools = (liveModel.tools as Json[]) ?? [];
  const desiredTools = desired.model.tools as Json[];
  const prompt = ((liveModel.messages as Json[]) ?? []).find((m) => m.role === 'system')?.content;

  check('system prompt matches', prompt === desired.model.messages[0]!.content, failures);
  check(`model is ${desired.model.model}`, liveModel.model === desired.model.model, failures);
  check(
    'tools match (endCall, check_consult_availability, book_consultation)',
    JSON.stringify(liveTools.map((t) => (t.function as Json | undefined)?.name ?? t.type)) ===
      JSON.stringify(desiredTools.map((t) => (t.function as Json | undefined)?.name ?? t.type)),
    failures,
  );
  for (const tool of liveTools.filter((t) => t.type === 'function')) {
    const server = tool.server as Json | undefined;
    const name = (tool.function as Json).name;
    check(`${name} posts to ${webhookUrl}`, server?.url === webhookUrl, failures);
    check(
      `${name} sends the webhook secret`,
      (server?.headers as Json | undefined)?.['x-vapi-secret'] === webhookSecret,
      failures,
    );
  }
  const liveServer = live.server as Json | undefined;
  check('call events post to the webhook', liveServer?.url === webhookUrl, failures);
  check(
    'call events send the webhook secret',
    (liveServer?.headers as Json | undefined)?.['x-vapi-secret'] === webhookSecret,
    failures,
  );
  check(
    'waits for the prospect to speak first',
    live.firstMessageMode === 'assistant-waits-for-user',
    failures,
  );
  check(
    'automatic voicemail detection off (the agent judges greetings and menus)',
    !live.voicemailDetection || live.voicemailDetection === 'off',
    failures,
  );
  check('no voicemail message is left', !live.voicemailMessage, failures);
  check('no automatic goodbye spoken onto voicemails', !live.endCallMessage, failures);
  check(
    'spoken goodbyes hang up the call (endCallPhrases)',
    JSON.stringify(live.endCallPhrases) === JSON.stringify(desired.endCallPhrases),
    failures,
  );
  check(
    'keypad (dtmf) tool available for phone menus',
    liveTools.some((t) => t.type === 'dtmf'),
    failures,
  );
  check(
    'waits at least 60 seconds of silence for call screeners',
    Number(live.silenceTimeoutSeconds) >= 60,
    failures,
  );
  check(
    'structured call analysis enabled',
    ((live.analysisPlan as Json | undefined)?.structuredDataPlan as Json | undefined)?.enabled ===
      true,
    failures,
  );

  const phone = await vapi<Json>('GET', `/phone-number/${phoneNumberId}`);
  check(`phone number is ${phone.number}`, typeof phone.number === 'string', failures);
  check(
    'phone number has no fixed assistant (callbacks use assistant-request)',
    !phone.assistantId,
    failures,
  );
  check(
    'phone number server is the webhook',
    (phone.server as Json | undefined)?.url === webhookUrl,
    failures,
  );
  check(
    'phone number sends the webhook secret',
    ((phone.server as Json | undefined)?.headers as Json | undefined)?.['x-vapi-secret'] ===
      webhookSecret,
    failures,
  );

  console.log(`\nVAPI_ASSISTANT_ID=${assistant.id}`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed.`);
    process.exit(1);
  }
  console.log('All checks passed.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
