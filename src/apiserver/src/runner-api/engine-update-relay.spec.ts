import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RunnerStatus } from '@orbit/shared';
import { RunnerApiController } from './runner-api.controller';
import { RunnersService, installStateOf } from '../runners/runners.service';

const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

/**
 * One relay slot carries two jobs — installing a named CLI, and updating every CLI already on the
 * machine — because both drive a package manager against that machine's single global prefix and
 * must not overlap. Nearly everything about the slot is shared; the handful of places that must
 * tell the two apart are what this file pins down. Each of them fails silently: the button still
 * renders, the request still gets written, and the user is simply never told what happened.
 */

// ---------------------------------------------------------------------------------------------
// Which job the row is running, as the browser sees it.
// ---------------------------------------------------------------------------------------------

test('a relay row reports which of the two jobs it is running', () => {
  const row = {
    installStatus: 'installing',
    installEngine: null,
    installCommand: 'orbit engine-update',
    installMessage: null,
    installMode: 'update',
  };
  assert.deepEqual(installStateOf(row), {
    status: 'installing',
    // An update is the machine's business, not one row's, so it names no engine.
    engine: null,
    command: 'orbit engine-update',
    message: null,
    mode: 'update',
  });
});

test('a row written before updates shared this relay reads as an install', () => {
  // Not hypothetical: every row in flight when the column was added has a NULL mode, and a client
  // that has never heard of modes assumes the same thing.
  const legacy = installStateOf({
    installStatus: 'installing',
    installEngine: 'kimi',
    installCommand: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash',
    installMessage: null,
    installMode: null,
  });
  assert.equal(legacy.mode, 'install');
  assert.equal(legacy.engine, 'kimi');
});

test('an idle slot claims neither job', () => {
  // `mode` has to go quiet with `status`; a lingering 'update' would put a stale summary panel
  // on a card with nothing in flight.
  assert.deepEqual(
    installStateOf({
      installStatus: null,
      installEngine: 'kimi',
      installCommand: 'x',
      installMessage: 'y',
      installMode: 'update',
    }),
    { status: null, engine: null, command: 'x', message: 'y', mode: null },
  );
});

// ---------------------------------------------------------------------------------------------
// Starting an update.
// ---------------------------------------------------------------------------------------------

function serviceHarness(runner: Record<string, unknown> | null) {
  const updates: Record<string, unknown>[] = [];
  const prisma = {
    runner: {
      findFirst: async () => runner,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { ...runner, ...data };
      },
    },
  } as never;
  return { service: new RunnersService(prisma), updates };
}

test('starting an update clears the engine an earlier install left behind', async () => {
  // The slot is reused, so whatever the last install wrote is still sitting in these columns. A
  // stale engine would make the update look like an install of that CLI on every reader.
  const h = serviceHarness({
    id: RUNNER_ID,
    status: RunnerStatus.ONLINE,
    installStatus: 'failed',
    installEngine: 'kimi',
    installCommand: 'curl … | bash',
    installMessage: 'the installer finished but `kimi` still isn\'t on this machine\'s service PATH.',
    installMode: 'install',
  });

  const state = await h.service.startEngineUpdate(OWNER, RUNNER_ID);

  assert.equal(h.updates.length, 1);
  assert.deepEqual(
    { ...h.updates[0], installAt: undefined },
    {
      installStatus: 'pending',
      installEngine: null,
      installCommand: null,
      installMessage: null,
      installMode: 'update',
      installAt: undefined,
    },
  );
  assert.ok(h.updates[0].installAt instanceof Date, 'installAt stamps the attempt the runner echoes back');
  assert.equal(state.mode, 'update');
  assert.equal(state.status, 'pending');
});

test('an offline machine is refused rather than queued', async () => {
  // The request is only ever delivered on a heartbeat, so queueing one for a machine that is not
  // heartbeating parks a row that does nothing until it times out twelve minutes later.
  const h = serviceHarness({ id: RUNNER_ID, status: RunnerStatus.OFFLINE });
  await assert.rejects(() => h.service.startEngineUpdate(OWNER, RUNNER_ID), BadRequestException);
  assert.equal(h.updates.length, 0, 'a refused update must not touch the row');
});

test('another owner\'s machine is not found', async () => {
  const h = serviceHarness(null);
  await assert.rejects(() => h.service.startEngineUpdate(OWNER, RUNNER_ID), NotFoundException);
  assert.equal(h.updates.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Delivering it, and retiring it.
// ---------------------------------------------------------------------------------------------

function controllerHarness(runnerRow: Record<string, unknown>) {
  const updates: Record<string, unknown>[] = [];
  let current: Record<string, unknown> = { maxConcurrent: 4, ...runnerRow };
  const prisma = {
    runner: {
      findUnique: async () => current,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
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
  return {
    controller: new RunnerApiController(prisma, {} as never, realtime, {} as never, {} as never, {} as never, {} as never),
    updates,
    row: () => current,
  };
}

const beat = (controller: RunnerApiController, engines?: unknown[]) =>
  controller.heartbeat(
    { id: RUNNER_ID, version: null },
    { status: RunnerStatus.ONLINE, idleCapacity: 1, ...(engines ? { engines } : {}) } as never,
  );

test('a pending update is delivered naming no engine', async () => {
  const h = controllerHarness({
    installStatus: 'pending',
    installEngine: null,
    installAt: new Date(),
    installMode: 'update',
  });

  const response = await beat(h.controller);

  // Without the mode the runner would fall through to the install path, which needs an engine —
  // and finding none, would do nothing at all.
  assert.deepEqual(
    { engine: response.installRequest?.engine, mode: response.installRequest?.mode },
    { engine: undefined, mode: 'update' },
  );
  assert.ok(response.installRequest?.attempt, 'the attempt id lets the runner spot a redelivery');
});

test('an install still names its engine', async () => {
  const h = controllerHarness({
    installStatus: 'pending',
    installEngine: 'kimi',
    installAt: new Date(),
    installMode: null,
  });
  const response = await beat(h.controller);
  assert.equal(response.installRequest?.engine, 'kimi');
  assert.equal(response.installRequest?.mode, 'install');
});

test('a finished install is retired once the probe confirms it', async () => {
  const h = controllerHarness({
    installStatus: 'done',
    installEngine: 'kimi',
    installAt: new Date(),
    installMode: 'install',
  });

  await beat(h.controller, [{ engine: 'kimi', installed: true, auth: 'no' }]);

  const cleared = h.updates.find((u) => u.installStatus === null);
  assert.ok(cleared, 'the row goes back to speaking from engine health, which offers the sign-in');
  assert.equal(cleared.installMode, null);
});

test('a finished update outlives the probe, because its summary lives nowhere else', async () => {
  // The deliberate asymmetry. An install's outcome is re-derivable — the probe reports whether the
  // binary is there. An update's is not: what moved, what was skipped and why exists only in this
  // message, and it is the answer to a button the user pressed. Clearing it on the next heartbeat
  // (~30s) would make the button look like it did nothing.
  //
  // The row deliberately carries an engine name here. Today startEngineUpdate writes NULL, which
  // means the engine-match below can't succeed and the update survives for a reason that has
  // nothing to do with the rule being tested — a test set up the obvious way passes even with the
  // rule deleted. Naming an engine forces the match, so only the mode can save the row.
  const h = controllerHarness({
    installStatus: 'done',
    installEngine: 'claude',
    installAt: new Date(),
    installMode: 'update',
    installMessage: "Claude Code — 2 sessions running, it'll update once they finish",
  });

  await beat(h.controller, [{ engine: 'claude', installed: true, auth: 'yes' }]);

  assert.ok(
    !h.updates.some((u) => u.installStatus === null),
    'an update summary must survive until the user dismisses it',
  );
  assert.equal(h.row().installStatus, 'done');
});

test('an abandoned relay is swept, and says which job it was', async () => {
  // Past the runner's own ceiling there is no process behind the row, and leaving it in flight
  // would block the next attempt. The wording has to match the job, or it sends the user after
  // the wrong command.
  const longAgo = new Date(Date.now() - 13 * 60_000);
  for (const [mode, expected] of [
    ['update', 'orbit engine-update'],
    [null, 'run the command by hand'],
  ] as const) {
    const h = controllerHarness({
      installStatus: 'installing',
      installEngine: mode ? null : 'kimi',
      installAt: longAgo,
      installMode: mode,
    });

    const response = await beat(h.controller);

    assert.equal(response.installRequest, undefined, 'a timed-out relay is not redelivered');
    const failed = h.updates.find((u) => u.installStatus === 'failed');
    assert.ok(failed, `${mode ?? 'install'} should be swept`);
    assert.match(String(failed.installMessage), new RegExp(expected));
  }
});
