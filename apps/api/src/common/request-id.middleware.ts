import { randomUUID } from 'node:crypto';

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

const HEADER_IN = 'x-request-id';
const HEADER_OUT = 'x-request-id';

/**
 * Assigns a stable request ID to every incoming request and echoes it back on
 * the response so clients (and Twilio's debugger) can correlate logs.
 *
 * Honors a caller-supplied `X-Request-Id` if it looks like a UUID or short
 * opaque token (max 64 chars, ASCII printable). Otherwise mints a fresh
 * UUID v4.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const supplied = req.header(HEADER_IN);
    const id = isValidRequestId(supplied) ? (supplied as string) : randomUUID();
    req.requestId = id;
    res.setHeader(HEADER_OUT, id);
    next();
  }
}

function isValidRequestId(value: string | undefined): boolean {
  if (!value) return false;
  if (value.length > 64) return false;
  return /^[A-Za-z0-9._:-]+$/.test(value);
}
