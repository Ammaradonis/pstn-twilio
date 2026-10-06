import type { Readable } from 'stream';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { TwilioService } from '../twilio/twilio.service';

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';
const TIMEOUT_MS = 60_000;

/**
 * Voicemail to text with Deepgram. Twilio's own <Record transcribe> is not
 * available on this account (error 13620: recording encryption or PCI mode),
 * and Deepgram also handles messages over two minutes and other languages.
 */
@Injectable()
export class VoicemailTranscriber {
  constructor(
    private readonly config: ConfigService,
    private readonly twilio: TwilioService,
  ) {}

  get enabled(): boolean {
    return Boolean(this.config.get<string>('DEEPGRAM_API_KEY'));
  }

  /** The recording's text, or null when nothing was said. */
  async transcribe(recordingSid: string): Promise<string | null> {
    const key = this.config.get<string>('DEEPGRAM_API_KEY');
    if (!key) throw new Error('DEEPGRAM_API_KEY is not set');
    const media = await this.twilio.fetchRecordingMedia(recordingSid);
    const audio = await readAll(media.stream);
    const params = new URLSearchParams({
      model: 'nova-3',
      smart_format: 'true',
      detect_language: 'true',
    });
    const response = await fetch(`${DEEPGRAM_URL}?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': media.contentType || 'audio/mpeg' },
      body: new Uint8Array(audio),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Deepgram transcription failed: ${response.status}`);
    const result = (await response.json()) as {
      results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
    };
    return result.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() || null;
  }
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}
