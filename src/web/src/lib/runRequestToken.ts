import { uuidToBase62 } from '@orbit/shared';
import { ApiError } from '../api';

/**
 * THE NAME ONE RUN REQUEST CARRIES, drawn at the gesture that makes it.
 *
 * `POST /tasks/:id/execute` and `POST /tasks/batch-execute` both take a `triggerId`, and the server
 * keys this request's receipt on it (src/apiserver/src/tasks/task-run-identity.ts). What the server
 * cannot decide for itself is the one thing that matters here: a retry of press A and a fresh press
 * B are the same bytes on the wire, so which of the two a request IS has to be CARRIED.
 *
 * WHERE IT IS DRAWN IS THE WHOLE DESIGN. Once per user gesture — the click — and then handed down
 * as a mutation VARIABLE, which is what fixes the boundary in place:
 *
 *  - everything below the click reuses it, because it is an input rather than something computed
 *    on the way past. The 401 refresh-and-retry inside `authedFetch` re-sends the very `init` it
 *    was given; a react-query mutation retry re-invokes `mutationFn` with the SAME variables. Both
 *    are the same request and both say so.
 *  - a NEW click draws a new one, unconditionally — including a click over an error the last one
 *    left on screen. That press is a person deciding to run the task again, and answering it from
 *    the failed press's receipt would be answering a question nobody asked.
 *
 * Base62, the spelling every id above this API line is written in: `@IsPublicId` decodes it to the
 * UUID the receipt is keyed on, so a token spelled this way and a raw UUID reach the same row.
 */
export function newRunRequestToken(): string {
  // FAIL CLOSED. `crypto.getRandomValues` is the CSPRNG every browser this app can run in has had
  // for over a decade, and unlike `crypto.randomUUID` it is not restricted to secure contexts. Its
  // absence means there is no source of unguessable bytes at all — and a run request named from a
  // guessable or repeating source is worse than an unnamed one: two presses that draw the same name
  // are one run, silently, and the loser never happens. So the press does not go out.
  //
  // `typeof crypto` rather than `crypto?.` — optional chaining still throws on an identifier that
  // was never declared, which is the only case this guard is for.
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error(
      'This browser exposes no cryptographic randomness, so this run cannot be named — and an ' +
        'unnamed run cannot be retried safely. Open Orbit over HTTPS and try again.',
    );
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // Shaped as a v4 UUID so the token the server decodes is a well-formed one: `@IsPublicId` runs
  // `IsUUID('all')` on the decoded value, and 128 unshaped bits are not guaranteed to satisfy it.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return uuidToBase62(
    [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-'),
  );
}

/**
 * HOW FAR A NAMED RUN REQUEST IS RESENT, and how long it waits between attempts.
 *
 * Three resends after the first attempt, backing off 250ms → 500ms → 1s: a bounded ~1.75s in the
 * worst case, and then the press fails visibly and the reader decides. Bounded because this is for
 * a dropped connection and a lease being handed over, not for an outage.
 */
export const RUN_REQUEST_RESEND_ATTEMPTS = 3;
const RUN_REQUEST_RESEND_BASE_MS = 250;

/** The server's own name for "somebody is answering this exact request right now". */
export const TASK_RUN_REQUEST_IN_PROGRESS = 'TASK_RUN_REQUEST_IN_PROGRESS';

/**
 * Whether this failure means the press never got an ANSWER.
 *
 * `api()` throws two different kinds of thing, and the difference is most of the policy:
 *
 *  - an `ApiError` means the server answered — 400, 403, 409 `TASK_RUN_REQUEST_MISMATCH`, 503. That
 *    answer IS the result. Resending it would turn one structured refusal into three and change
 *    nothing about it.
 *  - anything else is `fetch` itself rejecting: DNS, a dropped connection, a killed proxy, a
 *    navigation. No answer was ever received — and the request may well have been delivered and
 *    committed, which is precisely the case this is for.
 *
 * A cancelled request is not a lost one: the caller withdrew it, and resending would put back
 * something that was deliberately taken away.
 */
export function isLostRunAnswer(error: unknown): boolean {
  if (error instanceof ApiError) return false;
  if (error instanceof Error && error.name === 'AbortError') return false;
  return error instanceof Error;
}

/**
 * Whether the server said this exact request is BEING ANSWERED right now.
 *
 * The one HTTP answer here that is not a result. It is what the first delivery's own lease holder
 * says to the second delivery — "nothing was changed by this delivery, ask again with the same
 * triggerId to read the answer" — and it is exactly the window a lost answer lands in: the first
 * POST is still committing when the resend arrives. Stopping here would hand the reader a failure
 * for a run that is starting, and their next click — a new name — would start a second one.
 *
 * Matched on the server's own `code`, never on its prose, and never on the bare status: the same
 * door answers 409 for `TASK_RUN_REQUEST_MISMATCH` (one id naming two requests), which asking again
 * can only repeat.
 */
export function isRunRequestInProgress(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409
    && error.code === TASK_RUN_REQUEST_IN_PROGRESS;
}

/**
 * The resend policy for the two run endpoints, and ONLY for them.
 *
 * WHAT LICENSES IT IS THE TOKEN. react-query re-invokes `mutationFn` with the SAME variables, and
 * the variables are where the press's name lives (`newRunRequestToken`) — so every attempt is
 * byte-identical, and the server answers the second delivery of one press from the first one's
 * receipt instead of starting a second run. Without the resend, a press whose ANSWER was lost fails
 * on screen while its run is already going, and the next click — a new name — starts a second one.
 *
 * Two conditions and no others: no answer came back at all, or the answer was "this request is
 * being answered right now, ask again". Everything else the server says is the result.
 *
 * Spread into a mutation that carries a `triggerId` and nowhere else. An unnamed POST resent is a
 * duplicate write, which is why nothing generic in `api()` retries.
 */
export const runRequestResend = {
  // `failureCount` is the number of failures BEFORE this one — 0 on the first — so this allows
  // exactly RUN_REQUEST_RESEND_ATTEMPTS resends and no more (@tanstack/query-core's retryer).
  retry: (failureCount: number, error: Error): boolean =>
    failureCount < RUN_REQUEST_RESEND_ATTEMPTS
    && (isLostRunAnswer(error) || isRunRequestInProgress(error)),
  retryDelay: (failureCount: number): number => RUN_REQUEST_RESEND_BASE_MS * 2 ** failureCount,
};
