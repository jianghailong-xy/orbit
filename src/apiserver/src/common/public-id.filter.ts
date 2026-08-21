import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { addTwins, boundaryOf } from './public-id-body';

/**
 * The id rule on the way OUT of a refusal.
 *
 * `PublicIdInterceptor` is `next.handle().pipe(map(…))`: it maps the value a handler returns, and
 * a thrown `ConflictException` never passes through it. So a refusal that names a row — and the
 * useful ones all do; "you cannot finish this project, the acceptance that says so is <id>" is
 * only actionable because of the id — served that id as a raw UUID while every success body on the
 * same endpoint served base62. Found by an independent acceptance of unit 25E against AC1, on
 * `PATCH /projects/:id` → `ACCEPTANCE_MISSING`, whose `runId` was the `project_acceptance_run`
 * primary key spelled the one way the rest of the API had stopped spelling it.
 *
 * A filter rather than a `uuidToBase62` at the throw site, because the throw site is where this
 * gets forgotten: there are five `AcceptanceRefusal`s in one function alone, and the next one
 * added would have to remember a rule nothing enforces. This is the same argument the interceptor
 * makes for the success path, so it is the same mechanism, over the same allowlist, keyed on the
 * same boundary — see `public-id-body.ts`.
 *
 * WHAT IT DOES NOT DO: rewrite ids embedded in prose. `message` is a sentence, not an address
 * slot, and a UUID inside one may be a `refs/orbit-base/<id>` path or a lease token quoted back
 * verbatim, which a rewrite would silently falsify. Both directions of this migration are keyed on
 * FIELD NAMES precisely so no code has to guess what a uuid-shaped substring means. A message that
 * wants to name a row spells it base62 itself — `project-acceptance.service.ts` does — and the
 * refusal scenarios in `project-acceptance.pg.spec.ts` assert no raw UUID survives anywhere in the
 * served body, prose included.
 */
@Catch()
export class PublicIdExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      // A string response is `{ statusCode, message }` by the time the base filter is done with
      // it: no field to key on, nothing to do. Objects are mapped in place, which is what the base
      // filter then serializes.
      if (body !== null && typeof body === 'object') addTwins(body, boundaryOf(host));
    }
    // Everything else — the reply, the headers-already-sent case, the 500 an unknown error becomes
    // and the log line that goes with it — stays Nest's default behaviour, unchanged.
    super.catch(exception, host);
  }
}
