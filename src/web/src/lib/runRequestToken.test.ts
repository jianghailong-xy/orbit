import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRANSIENT_DB_CONFLICT_CODE, base62ToUuid } from '@orbit/shared';
import { ApiError } from '../api';
import {
  RUN_REQUEST_RESEND_ATTEMPTS,
  TASK_RUN_REQUEST_IN_PROGRESS,
  isLostRunAnswer,
  isRunRequestInProgress,
  newRunRequestToken,
  runRequestResend,
} from './runRequestToken';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the token one Run gesture draws', () => {
  it('is a Base62 public id the server decodes to the UUID it keys the receipt on', () => {
    const token = newRunRequestToken();

    // Not merely "a string": `@IsPublicId` decodes it and runs `IsUUID('all')` on the result, so a
    // token invented in some other shape is a 400 rather than a run.
    expect(token).toMatch(/^[0-9A-Za-z]+$/);
    const decoded = base62ToUuid(token);
    expect(decoded).toMatch(UUID_RE);
    expect(decoded[14]).toBe('4'); // shaped as a v4 UUID, which is what IsUUID('all') accepts
    expect('89ab').toContain(decoded[19]); // ...and the RFC 4122 variant
  });

  it('is a NEW name on every draw — one gesture, one request', () => {
    // The half that must keep working: two deliberate presses are two runs. There is no state
    // between draws to make them agree, which is the point — a gesture cannot inherit another's
    // name, not even the name of a gesture that failed.
    const drawn = new Set(Array.from({ length: 256 }, () => newRunRequestToken()));

    expect(drawn.size).toBe(256);
  });

  it('fails closed where the browser exposes no cryptographic randomness', () => {
    // An unnamed run cannot be retried safely, and a run named from a guessable or repeating
    // source is worse: two presses that draw the same name are silently one run. So the press does
    // not go out — the mutation surfaces this as its error, and nothing is sent.
    vi.stubGlobal('crypto', {});
    expect(() => newRunRequestToken()).toThrow(/cryptographic randomness/);

    vi.stubGlobal('crypto', undefined);
    expect(() => newRunRequestToken()).toThrow(/cryptographic randomness/);
  });

  it('needs only getRandomValues, which is not restricted to secure contexts', () => {
    // Deliberately NOT `crypto.randomUUID`: that one is secure-context only, so naming a press
    // through it would silently give up idempotency on exactly the deployments that have no TLS.
    const getRandomValues = vi.fn((a: Uint8Array) => a.fill(7));
    vi.stubGlobal('crypto', { getRandomValues });

    const token = newRunRequestToken();

    expect(getRandomValues).toHaveBeenCalledTimes(1);
    expect(base62ToUuid(token)).toMatch(UUID_RE);
  });
});

describe('resending a press whose answer was lost', () => {
  it('resends only when no answer came back at all', () => {
    // `fetch` rejecting means the press may well have been delivered AND committed, with only the
    // answer lost. That is the case this exists for.
    expect(isLostRunAnswer(new TypeError('Failed to fetch'))).toBe(true);
    expect(isLostRunAnswer(new Error('network error'))).toBe(true);
  });

  it('never resends an answer the server actually gave', () => {
    // A structured refusal IS the result. Resending a 409 TASK_RUN_REQUEST_MISMATCH turns one
    // refusal into three and changes nothing; resending a 400 re-sends a request already judged.
    expect(isLostRunAnswer(new ApiError('mismatch', 409, 'TASK_RUN_REQUEST_MISMATCH'))).toBe(false);
    expect(isLostRunAnswer(new ApiError('nope', 400))).toBe(false);
    expect(isLostRunAnswer(new ApiError('busy', 503, TRANSIENT_DB_CONFLICT_CODE))).toBe(false);
  });

  it('never resends something the caller withdrew', () => {
    const cancelled = new Error('Aborted');
    cancelled.name = 'AbortError';

    expect(isLostRunAnswer(cancelled)).toBe(false);
  });

  it('asks again when the server says this request is being answered right now', () => {
    // The first delivery still holds the lease; nothing was changed by the second, and the answer
    // exists but is not ready. This is exactly the window a resend lands in — stopping here would
    // report a failure for a run that is starting.
    const inProgress = new ApiError('being answered', 409, TASK_RUN_REQUEST_IN_PROGRESS);

    expect(isRunRequestInProgress(inProgress)).toBe(true);
    expect(runRequestResend.retry(0, inProgress)).toBe(true);
    // ...and it is NOT a lost answer: the server did reply, it just has not settled.
    expect(isLostRunAnswer(inProgress)).toBe(false);
  });

  it('tells the two 409s apart by code, never by status', () => {
    // The same door answers 409 for `TASK_RUN_REQUEST_MISMATCH` — one id naming two requests —
    // which asking again can only repeat. Retrying on the status would loop on it.
    const mismatch = new ApiError('already used', 409, 'TASK_RUN_REQUEST_MISMATCH');

    expect(isRunRequestInProgress(mismatch)).toBe(false);
    expect(runRequestResend.retry(0, mismatch)).toBe(false);
    expect(isRunRequestInProgress(new ApiError('busy', 409))).toBe(false);
    // ...and not on a different status carrying the same code either.
    expect(isRunRequestInProgress(new ApiError('x', 500, TASK_RUN_REQUEST_IN_PROGRESS))).toBe(false);
  });

  it('is bounded, and backs off between attempts', () => {
    const lost = new TypeError('Failed to fetch');
    // `failureCount` counts the failures BEFORE this decision, so 0 is the first one. Exactly
    // RUN_REQUEST_RESEND_ATTEMPTS resends are allowed; the next failure ends the press on screen.
    expect(runRequestResend.retry(0, lost)).toBe(true);
    expect(runRequestResend.retry(RUN_REQUEST_RESEND_ATTEMPTS - 1, lost)).toBe(true);
    expect(runRequestResend.retry(RUN_REQUEST_RESEND_ATTEMPTS, lost)).toBe(false);
    // ...and an answered request is not resent even on the first failure.
    expect(runRequestResend.retry(0, new ApiError('nope', 400))).toBe(false);

    expect(runRequestResend.retryDelay(1)).toBeGreaterThan(runRequestResend.retryDelay(0));
  });
});
