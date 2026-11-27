import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunStatus } from '@orbit/shared';
import { AutoRetryService } from './auto-retry.service';

/**
 * Whether a session parked idle is stopped on a failure, by its latest reply (auto-retry.service.ts stoppedOnFailure),
 * as it read that reply before the failure kinds (review of revision 1, point 3): a spent quota opening the reply, a
 * provider that could not answer, or the runtime's "Failed to authenticate" (isAuthErrorText) — and nothing more. A
 * Codex "Not logged in" was never one of them and still is not; a runner's stored kind decides over the words.
 */
type Stopped = { stoppedOnFailure(db: unknown, sessionId: string): Promise<boolean> };

function stopped(reply: string, failureKind: string | null = null): Promise<boolean> {
  const db = {
    session: {
      findUnique: async () => ({
        finishedAt: null, endReason: null, lastTurnOutcome: 'ANSWERED', status: RunStatus.AWAITING_INPUT,
        retryAt: null, retryClaimedAt: null, cancelRequestedAt: null, failureKind,
      }),
    },
    runEvent: { findMany: async () => [{ payload: { text: reply } }] },
  };
  const service = new AutoRetryService({} as never, {} as never, {} as never) as unknown as Stopped;
  return service.stoppedOnFailure(db, 'session-1');
}

test('a reply that is a spent quota, an API error or "Failed to authenticate" stops the session, as before', async () => {
  assert.equal(await stopped("You've hit your session limit · resets 6:20pm (Europe/Berlin)"), true);
  assert.equal(await stopped('API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}'), true);
  assert.equal(await stopped('Failed to authenticate: OAuth session expired and could not be refreshed'), true);
});

test('an unwrapped "Not logged in" or "OAuth session expired" reply does not, as before', async () => {
  assert.equal(await stopped('Not logged in · Please run /login'), false);
  assert.equal(await stopped('OAuth session expired'), false);
  assert.equal(await stopped('Here is the summary you asked for.'), false);
});

test("a kind stored on the session decides over the reply's words", async () => {
  assert.equal(await stopped('Not logged in · Please run /login', 'CREDENTIAL_REFUSED'), true);
  assert.equal(await stopped('Failed to authenticate: OAuth session expired', 'REQUEST_REFUSED'), false);
});
