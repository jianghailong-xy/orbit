import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpServer, Logger } from '@nestjs/common';
import {
  TRANSIENT_DB_CONFLICT_CODE,
  TRANSIENT_DB_CONFLICT_RETRY_AFTER_SECONDS,
  transientDbConflictBody,
} from '@orbit/shared';
import { classifyTransactionError } from './transaction-retry';

/**
 * The last thing between a database conflict and the client: what a `40P01`, a `40001` or a
 * `P2034` becomes when nothing else caught it.
 *
 * Without this, all three left as a 500. That is the wrong answer twice over: it tells a caller
 * its request was broken when the request was fine and the server merely picked it as the victim
 * of a lock cycle, and it tells every client's retry policy to stop — a 500 is not something you
 * re-send. The correct answer is a 503 that says so, with a code the caller switches on and a
 * `Retry-After` it can honour. The contract itself lives in `@orbit/shared` because the web and
 * the CLI read it too.
 *
 * WHAT IT DOES NOT DO: retry. Re-running the work is `withTransactionRetry`'s job and only it can
 * do it correctly, because only the caller knows which closure to re-run and whether re-running is
 * safe. By the time an error is here the response is the only thing left to decide, and a conflict
 * that a retry loop already absorbed never arrives — that is what makes this a floor rather than a
 * second, invisible retry policy stacked under the first.
 *
 * It is also deliberately narrow. Anything that is already an `HttpException` — every business
 * 409, every 400, every endpoint that translated a `P2002` into its own refusal — goes past
 * untouched, and so does every unknown error, which keeps its 500. The verdict comes from
 * `classifyTransactionError`, the same one the retry loop uses, so the boundary and the loop can
 * never disagree about what "transient" means.
 *
 * Chained rather than registered alongside `PublicIdExceptionFilter`, because Nest runs exactly
 * ONE filter per exception: it reverses the global list and takes the first whose `@Catch()`
 * matches, so a second catch-all registered next to the existing one would not run after it — it
 * would replace it, and every refusal body would silently stop spelling its ids in base62.
 */
@Catch()
export class TransientDbConflictFilter implements ExceptionFilter {
  private readonly log = new Logger('TransientDbConflict');

  constructor(
    /** Where everything this boundary does not own goes, unchanged. */
    private readonly next: ExceptionFilter,
    private readonly httpAdapter: HttpServer,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    // Answered before classifying, not because the classifier would disagree — it refuses to call
    // anything wrapping an `HttpException` retryable — but because this is the rule that must hold
    // even if the classifier changes: a layer that already decided what to tell the client wins.
    if (exception instanceof HttpException) return this.next.catch(exception, host);

    const verdict = classifyTransactionError(exception);
    if (!verdict.retryable) return this.next.catch(exception, host);

    const http = host.switchToHttp();
    const request = http.getRequest<{ method?: string; route?: { path?: string } }>();
    const response = http.getResponse();

    // Everything on this line is a constant or a code from a closed set (`40001`, `40P01`,
    // `P2034`, or the literal `message` when only the driver's wording survived the wrapping).
    // The error's own text is never logged: it is the one place SQL, parameter values and a
    // prompt that happened to be in the row can appear. The route TEMPLATE (`/tasks/:id`) and not
    // the URL, for the same reason — a query string carries the SSE and attachment tokens, and
    // this line outlives the request.
    this.log.warn(
      `${verdict.reason} reached the API boundary · answered 503 ${TRANSIENT_DB_CONFLICT_CODE}` +
        ` · evidence=${verdict.evidence} depth=${verdict.depth}` +
        ` · ${request?.method ?? '?'} ${request?.route?.path ?? '?'}`,
    );

    // A conflict can equally well abort a write made halfway through an SSE stream, where the
    // status line left long ago. Setting a header then throws, and the base filter's own
    // headers-sent path is what ends the response.
    if (!this.httpAdapter.isHeadersSent(response)) {
      this.httpAdapter.setHeader(response, 'Retry-After', String(TRANSIENT_DB_CONFLICT_RETRY_AFTER_SECONDS));
    }

    // Handed on as an `HttpException` rather than replied to directly, so this answer leaves by
    // the same door as every other one — through the id spelling and Nest's own serialization.
    this.next.catch(new HttpException(transientDbConflictBody(), 503), host);
  }
}
