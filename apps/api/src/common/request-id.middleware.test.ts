import { describe, expect, it, vi } from 'vitest';

import { RequestIdMiddleware } from './request-id.middleware';

function buildReq(headers: Record<string, string | undefined> = {}) {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as any;
}

function buildRes() {
  const headers: Record<string, string> = {};
  return {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    }),
    get headers() {
      return headers;
    },
  };
}

describe('RequestIdMiddleware', () => {
  it('mints a fresh UUID when no header is supplied', () => {
    const mw = new RequestIdMiddleware();
    const req = buildReq();
    const res = buildRes();
    const next = vi.fn();
    mw.use(req, res as never, next);
    expect(next).toHaveBeenCalled();
    expect(typeof req.requestId).toBe('string');
    expect(req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', req.requestId);
  });

  it('honors a valid supplied X-Request-Id', () => {
    const mw = new RequestIdMiddleware();
    const req = buildReq({ 'x-request-id': 'caller-abc-123' });
    const res = buildRes();
    mw.use(req, res as never, vi.fn());
    expect(req.requestId).toBe('caller-abc-123');
    expect(res.setHeader).toHaveBeenCalledWith('x-request-id', 'caller-abc-123');
  });

  it('rejects malformed X-Request-Id and mints a fresh one instead', () => {
    const mw = new RequestIdMiddleware();
    const req = buildReq({ 'x-request-id': 'not valid because of spaces' });
    const res = buildRes();
    mw.use(req, res as never, vi.fn());
    expect(req.requestId).not.toBe('not valid because of spaces');
    expect(req.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('rejects oversize X-Request-Id (>64 chars)', () => {
    const mw = new RequestIdMiddleware();
    const big = 'a'.repeat(65);
    const req = buildReq({ 'x-request-id': big });
    const res = buildRes();
    mw.use(req, res as never, vi.fn());
    expect(req.requestId).not.toBe(big);
  });
});
