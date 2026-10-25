import { STATUS_CODES } from 'node:http';

import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpServer, Logger } from '@nestjs/common';

import { recordConflictResponse } from './db-conflict-metrics';
import { isRunnerLinkCall } from './runner-link-call';
import { classifyTransactionFault } from './transaction-retry';

/** What a link call is answered with when the database failed under it rather than refused it. */
export const DATABASE_UNAVAILABLE_CODE = 'DATABASE_UNAVAILABLE';

/** How long a link call the database turned away waits before it is sent again. */
export const DATABASE_UNAVAILABLE_RETRY_AFTER_MS = 2_000;

/**
 * The retry hint in milliseconds, beside the standard `Retry-After`, which only counts whole seconds.
 * The gateway reads it into `TunnelResponse.retry_after_ms` (contracts/runner-link/v1/runner_link.proto)
 * and falls back to `Retry-After` when an answer carries only that one.
 */
export const RETRY_AFTER_MS_HEADER = 'Retry-After-Ms';

/** The fields every error a link call is answered with carries (docs/runner-link-design.md §5.6). */
export interface RunnerLinkErrorFields {
  /** A stable machine-readable code, in upper snake case. */
  code: string;
  /** Whether sending the same request again may succeed. */
  retryable: boolean;
  /** How long to wait before sending it again; absent when the runner's own backoff decides. */
  retryAfterMs?: number;
}

/** The served body of a database resource fault, in full. Every field is a constant. */
export function databaseUnavailableBody(): Record<string, unknown> & RunnerLinkErrorFields {
  return {
    statusCode: 503,
    error: 'Service Unavailable',
    code: DATABASE_UNAVAILABLE_CODE,
    message:
      'the database could not serve this request: it ran out of connections, or is failing over or shutting down; the same request can be sent again',
    retryable: true,
    retryAfterMs: DATABASE_UNAVAILABLE_RETRY_AFTER_MS,
  };
}

/**
 * The error boundary of a runner link call: every refusal and every failure it is answered with
 * carries `code`, `retryable` and, when there is one, a retry hint (docs/runner-link-design.md §5.6).
 * A request that is not a link call passes through untouched, so nothing served over HTTPS changes.
 *
 * Over HTTPS a runner reads its refusals by their status, and a database that ran out of resources
 * answered a plain 500: the conflict boundary in front of this one only turns a rolled-back
 * transaction into its typed 503, and a pool timeout (`P2024`), a transaction that could not start
 * (`P2028`) or a server out of connections, failing over or shutting down (SQLSTATE classes 08, 53,
 * 57, 58) left as the same 500 as a bug. On 2026-10-05 ten minutes of them made runners drop 66,771
 * events. On the link they are what they are, a retryable 503 `DATABASE_UNAVAILABLE`, classified by
 * the same `classifyTransactionFault` the retry loop and the conflict boundary read, so the three
 * never disagree about what a resource fault is.
 *
 * `retryable` is the body's own when it states one (the conflict boundary's 503 does); otherwise it
 * is the rule a runner applies over HTTPS today (`isRetryableTransportError`, src/runner-go/transport.go):
 * 408, 429 and every 5xx may succeed when sent again, other refusals will not. The one exception is a
 * failure the data itself decided (a duplicate key, a missing row: the `PERMANENT` family), which the
 * same request reaches again however often it is sent. `code` is the body's own, or the status
 * spelled in upper snake case (`CONFLICT`, `NOT_FOUND`); the body keeps everything else it had.
 *
 * Chained between the conflict boundary and the id filter (main.ts): the conflict boundary hands its
 * 503 on as an `HttpException`, which this one only completes with the hint in milliseconds, and the
 * id filter after it still spells every refusal's ids.
 */
@Catch()
export class RunnerLinkErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('RunnerLinkError');

  constructor(
    /** Where every answer goes next, the link's included. */
    private readonly next: ExceptionFilter,
    private readonly httpAdapter: HttpServer,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<{ method?: string; route?: { path?: string } }>();
    if (host.getType() !== 'http' || !isRunnerLinkCall(request)) return this.next.catch(exception, host);

    const response = http.getResponse<{ getHeader?: (name: string) => unknown }>();
    const answer = exception instanceof HttpException ? exception : this.answerFor(exception, request);
    const status = answer.getStatus();
    const body = runnerLinkErrorBody(answer.getResponse(), status, retryAfterSecondsOf(response));
    if (body.retryAfterMs && !this.httpAdapter.isHeadersSent(response)) {
      this.httpAdapter.setHeader(response, 'Retry-After', String(Math.ceil(body.retryAfterMs / 1000)));
      this.httpAdapter.setHeader(response, RETRY_AFTER_MS_HEADER, String(body.retryAfterMs));
    }
    this.next.catch(new HttpException(body, status), host);
  }

  /** What a link call is answered with for a failure no layer turned into an answer. */
  private answerFor(exception: unknown, request: { method?: string; route?: { path?: string } }): HttpException {
    const verdict = classifyTransactionFault(exception);
    if (verdict.family === 'RESOURCE') {
      // Counted with the conflict boundary's 503s: both are callers turned away by the database.
      recordConflictResponse({
        method: request?.method,
        route: request?.route?.path,
        handling: 'boundary_only',
        error: { family: verdict.family, reason: verdict.reason, evidence: verdict.evidence },
      });
      // Constants and codes from a closed set only, as on the conflict boundary's line: the error's
      // own text is where SQL and parameter values appear.
      this.log.warn(
        `database resource fault reached the link boundary · answered 503 ${DATABASE_UNAVAILABLE_CODE}` +
          ` · evidence=${verdict.evidence} depth=${verdict.depth}` +
          ` · ${request?.method ?? '?'} ${request?.route?.path ?? '?'}`,
      );
      return new HttpException(databaseUnavailableBody(), 503);
    }
    // The 500 it always was, logged as Nest logs one.
    const error = exception instanceof Error ? exception : new Error(String(exception));
    this.log.error(error.message, error.stack);
    return new HttpException(
      {
        statusCode: 500,
        message: 'Internal server error',
        code: 'INTERNAL_SERVER_ERROR',
        retryable: verdict.family !== 'PERMANENT',
      },
      500,
    );
  }
}

/** A refusal's body with the link's fields completed, everything else it said kept. */
export function runnerLinkErrorBody(
  raw: string | object,
  status: number,
  retryAfterSeconds?: number,
): Record<string, unknown> & RunnerLinkErrorFields {
  const body: Record<string, unknown> =
    raw !== null && typeof raw === 'object' ? { ...raw } : { statusCode: status, message: raw };
  const code = typeof body.code === 'string' && body.code !== '' ? body.code : codeForStatus(status);
  const retryable = typeof body.retryable === 'boolean' ? body.retryable : retryableStatus(status);
  const retryAfterMs =
    typeof body.retryAfterMs === 'number' ? body.retryAfterMs
    : typeof body.retryAfterSeconds === 'number' ? body.retryAfterSeconds * 1000
    : retryAfterSeconds !== undefined ? retryAfterSeconds * 1000
    : 0;
  const { retryAfterMs: _stated, ...rest } = body;
  return { ...rest, code, retryable, ...(retryable && retryAfterMs > 0 ? { retryAfterMs } : {}) };
}

/** The status spelled as a code: 409 is `CONFLICT`, 503 is `SERVICE_UNAVAILABLE`. */
function codeForStatus(status: number): string {
  return (STATUS_CODES[status] ?? `HTTP ${status}`)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** Today's HTTPS rule (src/runner-go/transport.go, isRetryableTransportError). */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** A `Retry-After` an earlier layer set on this response, in delta-seconds. */
function retryAfterSecondsOf(response: { getHeader?: (name: string) => unknown }): number | undefined {
  const value = Number(response?.getHeader?.('retry-after'));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}
