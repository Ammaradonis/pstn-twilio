import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Logs each HTTP request as a single structured line on completion, using a
 * deterministic field order so the output is grep-friendly and ingestible by
 * standard log shippers. Sensitive headers/bodies are never logged.
 */
@Injectable()
export class HttpLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('HTTP');

  use(req: Request, res: Response, next: NextFunction): void {
    const start = process.hrtime.bigint();
    const { method, originalUrl } = req;
    const reqId = req.requestId ?? '-';
    const userAgent = req.header('user-agent') ?? '-';
    const ip = req.ip ?? '-';

    res.on('finish', () => {
      const durationMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
      const status = res.statusCode;
      const line = `req_id=${reqId} ${method} ${originalUrl} status=${status} dur_ms=${durationMs} ip=${ip} ua="${truncate(userAgent, 80)}"`;
      if (status >= 500) this.logger.error(line);
      else if (status >= 400) this.logger.warn(line);
      else this.logger.log(line);
    });

    next();
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
