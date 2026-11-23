import { AsyncLocalStorage } from 'node:async_hooks';
import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * The apiserver's log lines, and the request each one was written for (docs/self-hosting.md, "Logs").
 *
 * With ORBIT_LOG_FORMAT=json, as docker-compose.yml sets it, every line is one JSON object: Nest's own fields (level,
 * pid, timestamp in epoch milliseconds, message, context, stack) and, for a line written while a request was being
 * served, `requestId`. That id is the one the web gateway made for the request (`$request_id`, gateway/nginx.conf),
 * which its access log ends with and which it sends on as X-Request-Id, so the gateway's line and the apiserver's
 * lines for one request are found by the same value. Without the variable the lines are Nest's text, as before, which
 * is what a process started outside Compose (a lab, `npm run start:dev`) keeps writing.
 *
 * The message text is unchanged either way, so a `grep 'connected to NATS at '` over `docker logs` matches as it did.
 */

const requests = new AsyncLocalStorage<{ requestId: string }>();

/** What may be taken as a request id: nginx's is 32 hex digits; anything else id-shaped and short is kept too. */
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Express middleware, first in the chain: runs the rest of the request with its X-Request-Id as the id its log lines
 * carry. A request without one, or with one that is not id-shaped, is served the same and its lines carry none. The web
 * gateway replaces whatever a client sent under that name, so the value is nginx's on every request that came through
 * it; the link gateway's calls on the internal listener carry none.
 */
export function requestIdContext(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers['x-request-id'];
  if (typeof header !== 'string' || !REQUEST_ID.test(header)) return next();
  requests.run({ requestId: header }, next);
}

/** The id of the request being served here, if any. */
export function currentRequestId(): string | undefined {
  return requests.getStore()?.requestId;
}

/** Nest's console logger in JSON mode, with the request's id on each line written while it is served. */
export class JsonRequestLogger extends ConsoleLogger {
  constructor() {
    super({ json: true });
  }

  protected override getJsonLogObject(
    message: unknown,
    options: { context: string; logLevel: LogLevel; writeStreamType?: 'stdout' | 'stderr'; errorStack?: unknown; params?: Record<string, any> },
  ) {
    const line = super.getJsonLogObject(message, options);
    const requestId = currentRequestId();
    if (requestId !== undefined) line.requestId = requestId;
    return line;
  }
}

/** The logger NestFactory.create takes: JSON with ORBIT_LOG_FORMAT=json, Nest's default (text) otherwise. */
export function apiserverLogger(env: NodeJS.ProcessEnv = process.env): ConsoleLogger | undefined {
  return env.ORBIT_LOG_FORMAT === 'json' ? new JsonRequestLogger() : undefined;
}
