import { Injectable } from '@nestjs/common';

import { AiCallingConfig } from './ai-calling.config';

const VAPI_BASE_URL = 'https://api.vapi.ai';

export class VapiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'VapiRequestError';
  }
}

export interface VapiCall {
  id: string;
  status?: string;
  endedReason?: string;
  startedAt?: string;
  endedAt?: string;
  cost?: number;
  analysis?: { summary?: string; structuredData?: Record<string, unknown> };
  artifact?: { transcript?: string; recordingUrl?: string };
  monitor?: { controlUrl?: string; listenUrl?: string };
}

@Injectable()
export class VapiClient {
  constructor(private readonly settings: AiCallingConfig) {}

  async createCall(body: Record<string, unknown>): Promise<VapiCall> {
    return this.request<VapiCall>('POST', '/call', body);
  }

  async getCall(id: string): Promise<VapiCall> {
    return this.request<VapiCall>('GET', `/call/${encodeURIComponent(id)}`);
  }

  // Sends a live call control message to the call's monitor.controlUrl.
  async sendControl(controlUrl: string, message: Record<string, unknown>): Promise<void> {
    if (!controlUrl.startsWith('https://')) throw new VapiRequestError(500, 'Invalid control URL');
    const res = await fetch(controlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new VapiRequestError(res.status, `Vapi live control failed: ${res.status}`);
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const key = this.settings.vapiPrivateKey;
    if (!key) throw new VapiRequestError(500, 'VAPI_PRIVATE_KEY is not set');
    const res = await fetch(`${VAPI_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const message = (parsed as { message?: unknown } | null)?.message;
      throw new VapiRequestError(
        res.status,
        Array.isArray(message)
          ? message.join('; ')
          : String(message ?? `Vapi ${method} ${path} failed`),
      );
    }
    return parsed as T;
  }
}
