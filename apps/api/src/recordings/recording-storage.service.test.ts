import { createHash } from 'crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { audioExtension, RecordingStorageService } from './recording-storage.service';

const SETTINGS: Record<string, string> = {
  CLOUDFLARE_ACCOUNT_ID: 'acct123',
  R2_ACCESS_KEY_ID: 'key-id',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_RECORDINGS_BUCKET: 'call-recordings',
};

function buildStorage(values: Record<string, string> = SETTINGS) {
  return new RecordingStorageService({ get: (name: string) => values[name] } as never);
}

afterEach(() => vi.unstubAllGlobals());

describe('RecordingStorageService', () => {
  it('is disabled until the R2 credentials and bucket are set', () => {
    expect(buildStorage({ CLOUDFLARE_ACCOUNT_ID: 'acct123' }).enabled).toBe(false);
    expect(buildStorage().enabled).toBe(true);
  });

  it('builds month-partitioned keys with the extension of the content type', () => {
    const key = buildStorage().keyFor({
      twilioCallSid: 'CA0123',
      name: 'RE0456',
      contentType: 'audio/webm;codecs=opus',
      at: new Date('2026-10-07T12:00:00Z'),
    });
    expect(key).toBe('recordings/2026/10/CA0123/RE0456.webm');
  });

  it('maps content types to file extensions', () => {
    expect(audioExtension('audio/mpeg')).toBe('mp3');
    expect(audioExtension('audio/webm;codecs=opus')).toBe('webm');
    expect(audioExtension('audio/mp4')).toBe('m4a');
    expect(audioExtension(null)).toBe('mp3');
  });

  it('uploads to the bucket and verifies the checksum and stored size', async () => {
    const body = Buffer.from('recording-bytes');
    const md5 = createHash('md5').update(body).digest('hex');
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) => {
        requests.push(request);
        if (request.method === 'PUT') return new Response(null, { headers: { etag: `"${md5}"` } });
        return new Response(null, { headers: { 'content-length': String(body.length) } });
      }),
    );

    await buildStorage().put('recordings/2026/10/CA1/RE1.mp3', body, 'audio/mpeg');

    expect(requests.map((r) => r.method)).toEqual(['PUT', 'HEAD']);
    expect(requests[0]!.url).toBe(
      'https://acct123.r2.cloudflarestorage.com/call-recordings/recordings/2026/10/CA1/RE1.mp3',
    );
    expect(requests[0]!.headers.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 /);
    expect(requests[0]!.headers.get('content-md5')).toBe(
      createHash('md5').update(body).digest('base64'),
    );
  });

  it('rejects an upload whose ETag does not match the body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { headers: { etag: '"not-the-md5"' } })),
    );

    await expect(
      buildStorage().put('recordings/x.mp3', Buffer.from('abc'), 'audio/mpeg'),
    ).rejects.toThrow('checksum mismatch');
  });

  it('rejects an upload when the stored size differs', async () => {
    const body = Buffer.from('abc');
    const md5 = createHash('md5').update(body).digest('hex');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (request: Request) =>
        request.method === 'PUT'
          ? new Response(null, { headers: { etag: md5 } })
          : new Response(null, { headers: { 'content-length': '1' } }),
      ),
    );

    await expect(buildStorage().put('recordings/x.mp3', body, 'audio/mpeg')).rejects.toThrow(
      'expected 3',
    );
  });
});
