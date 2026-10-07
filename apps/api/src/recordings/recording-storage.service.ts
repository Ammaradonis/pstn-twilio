import { createHash } from 'crypto';
import { Readable } from 'stream';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AwsClient } from 'aws4fetch';

export interface StoredRecording {
  stream: Readable;
  contentType: string;
}

interface StorageSettings {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const EXTENSIONS: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

/** File extension for an audio content type, ignoring parameters like codecs. */
export function audioExtension(contentType: string | null | undefined): string {
  const base = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  return EXTENSIONS[base] ?? 'mp3';
}

/**
 * Call recordings in Cloudflare R2, through its S3-compatible API. Turned off
 * until R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_RECORDINGS_BUCKET are
 * set (the account comes from R2_ACCOUNT_ID, else CLOUDFLARE_ACCOUNT_ID); until
 * then recordings stay at Twilio and browser recordings wait in the browser.
 */
@Injectable()
export class RecordingStorageService {
  private client: AwsClient | null = null;

  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return this.settings() !== null;
  }

  /** e.g. recordings/2026/10/CA…/RE….mp3 */
  keyFor(input: { twilioCallSid: string; name: string; contentType: string; at: Date }): string {
    const month = String(input.at.getUTCMonth() + 1).padStart(2, '0');
    const callSid = input.twilioCallSid.replace(/[^A-Za-z0-9_-]/g, '') || 'unknown';
    const name = input.name.replace(/[^A-Za-z0-9_-]/g, '');
    return `recordings/${input.at.getUTCFullYear()}/${month}/${callSid}/${name}.${audioExtension(input.contentType)}`;
  }

  /**
   * Uploads the file and confirms R2 stored exactly these bytes: the ETag of a
   * single-part upload is the body's MD5, and a HEAD must report the same size.
   */
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const md5 = createHash('md5').update(body).digest();
    const response = await this.request(key, {
      method: 'PUT',
      body: new Uint8Array(body),
      // Content-MD5 also makes R2 reject a body corrupted in transit.
      headers: { 'Content-Type': contentType, 'Content-MD5': md5.toString('base64') },
    });
    if (!response.ok) {
      throw new Error(`R2 upload failed: ${response.status} ${await errorText(response)}`);
    }
    const etag = response.headers.get('etag')?.replace(/"/g, '');
    if (etag && etag !== md5.toString('hex')) {
      throw new Error('R2 upload checksum mismatch');
    }
    const size = await this.size(key);
    if (size !== body.length) {
      throw new Error(`R2 stored ${size ?? 'no'} bytes, expected ${body.length}`);
    }
  }

  /** Size of a stored object in bytes, or null when it does not exist. */
  async size(key: string): Promise<number | null> {
    const response = await this.request(key, { method: 'HEAD' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`R2 HEAD failed: ${response.status}`);
    const length = Number(response.headers.get('content-length'));
    return Number.isFinite(length) ? length : null;
  }

  async get(key: string): Promise<StoredRecording> {
    const response = await this.request(key, { method: 'GET' });
    if (!response.ok || !response.body) {
      throw new Error(`R2 download failed: ${response.status}`);
    }
    return {
      stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      contentType: response.headers.get('content-type') ?? 'audio/mpeg',
    };
  }

  private async request(key: string, init: RequestInit): Promise<Response> {
    const settings = this.settings();
    if (!settings) throw new Error('Recording storage (R2) is not configured');
    this.client ??= new AwsClient({
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      service: 's3',
      region: 'auto',
      retries: 2,
    });
    const path = key.split('/').map(encodeURIComponent).join('/');
    return this.client.fetch(`${settings.endpoint}/${settings.bucket}/${path}`, init);
  }

  private settings(): StorageSettings | null {
    const accountId =
      this.config.get<string>('R2_ACCOUNT_ID') ?? this.config.get<string>('CLOUDFLARE_ACCOUNT_ID');
    const accessKeyId = this.config.get<string>('R2_ACCESS_KEY_ID');
    const secretAccessKey = this.config.get<string>('R2_SECRET_ACCESS_KEY');
    const bucket = this.config.get<string>('R2_RECORDINGS_BUCKET');
    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
    return {
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      bucket,
      accessKeyId,
      secretAccessKey,
    };
  }
}

async function errorText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 200);
  } catch {
    return '';
  }
}

export async function readAll(stream: Readable, maxBytes = Infinity): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) throw new Error(`Recording is larger than ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
