import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RunnerStatus } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';

/**
 * An engine can lose its sign-in with no session running and nothing failing: a Claude Code OAuth
 * refresh that doesn't go through clears the stored credential outright, and the runner keeps
 * heartbeating exactly as before. Nothing in Orbit used to say so, so the first sign was the next
 * session refusing to start — which in practice was hours later, on a machine the user believed
 * was working.
 *
 * The heartbeat is the only place that sees both sides of that change, and it sees them once. What
 * this file pins down is that "once": the alert has to fire on the edge and then stop, and it must
 * not fire on the two states that merely look like a sign-out.
 */

function harness(priorEngines: unknown) {
  const notified: { runnerId: string; engine: string }[] = [];
  let current: Record<string, unknown> = { maxConcurrent: 4, engines: priorEngines };
  const prisma = {
    runner: {
      findUnique: async () => current,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        current = { ...current, ...data };
        return current;
      },
    },
    session: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
  } as never;
  const realtime = {
    drainCancellations: async () => [],
    drainArtifactRequests: async () => [],
    failAbandonedWorktreeOperations: async () => {},
    drainMergeRequests: async () => [],
    drainCommitRequests: async () => [],
  } as never;
  const push = {
    notifyEngineSignedOut: async (runnerId: string, engine: string) => {
      notified.push({ runnerId, engine });
    },
  } as never;
  return {
    controller: new RunnerApiController(prisma, {} as never, realtime, push, {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never),
    notified,
  };
}

const beat = (controller: RunnerApiController, engines: unknown[]) =>
  controller.heartbeat(
    { id: RUNNER_ID, version: null },
    { status: RunnerStatus.ONLINE, idleCapacity: 1, engines } as never,
  );

test('an engine that was signed in and now is not alerts its owner', async () => {
  const h = harness([{ engine: 'claude', installed: true, auth: 'yes' }]);

  await beat(h.controller, [{ engine: 'claude', installed: true, auth: 'no' }]);

  assert.deepEqual(h.notified, [{ runnerId: RUNNER_ID, engine: 'claude' }]);
});

test('staying signed out alerts only on the beat that changed', async () => {
  // Heartbeats arrive every 30s and the signed-out state lasts until a human fixes it. Alerting on
  // the state rather than the edge would be a push every 30 seconds, indefinitely.
  const h = harness([{ engine: 'claude', installed: true, auth: 'yes' }]);

  await beat(h.controller, [{ engine: 'claude', installed: true, auth: 'no' }]);
  await beat(h.controller, [{ engine: 'claude', installed: true, auth: 'no' }]);
  await beat(h.controller, [{ engine: 'claude', installed: true, auth: 'no' }]);

  assert.equal(h.notified.length, 1, 'the sign-out is news once, not once per beat');
});

test('an engine the probe could not read is not reported as a sign-out', async () => {
  // 'unknown' is the answer for a CLI that wouldn't respond — a probe timeout, a version whose
  // status command changed shape. Treating it as a sign-out would wake people over a slow machine.
  const h = harness([{ engine: 'claude', installed: true, auth: 'unknown' }]);

  await beat(h.controller, [{ engine: 'claude', installed: true, auth: 'no' }]);

  assert.deepEqual(h.notified, []);
});

test('a machine that was never signed in has nothing to announce', async () => {
  // The first heartbeat after `orbit register` reports every engine as signed out. That is the
  // starting state, not an event, and it is the moment the user is already looking at the screen.
  const h = harness(null);

  await beat(h.controller, [{ engine: 'claude', installed: true, auth: 'no' }]);

  assert.deepEqual(h.notified, []);
});

test('signing back in re-arms the alert', async () => {
  // The recovery path in practice: the user signs in from the browser card, and days later the
  // same refresh failure happens again. The second sign-out has to be told as plainly as the first.
  const h = harness([{ engine: 'claude', installed: true, auth: 'yes' }]);

  await beat(h.controller, [{ engine: 'claude', installed: true, auth: 'no' }]);
  await beat(h.controller, [{ engine: 'claude', installed: true, auth: 'yes' }]);
  await beat(h.controller, [{ engine: 'claude', installed: true, auth: 'no' }]);

  assert.equal(h.notified.length, 2);
});

test('each engine on the machine is judged on its own', async () => {
  const h = harness([
    { engine: 'claude', installed: true, auth: 'yes' },
    { engine: 'codex', installed: true, auth: 'yes' },
    { engine: 'kimi', installed: true, auth: 'no' },
  ]);

  await beat(h.controller, [
    { engine: 'claude', installed: true, auth: 'yes' },
    { engine: 'codex', installed: true, auth: 'no' },
    { engine: 'kimi', installed: true, auth: 'no' },
  ]);

  assert.deepEqual(h.notified, [{ runnerId: RUNNER_ID, engine: 'codex' }]);
});
