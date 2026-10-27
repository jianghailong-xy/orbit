import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import type { RunnerInstallState } from '@orbit/shared';
import type { PrismaService } from '../prisma/prisma.service';
import { RUNNER_OFFLINE_AFTER_MS } from '../runners/runner-presence';
import type { RunnersService } from '../runners/runners.service';
import { RunnerEngineInstallController } from './runner-engine-install.controller';
import type { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';

/** The machine the calling session runs on, and the session the gate answers for. */
const CALLER = { id: 'caller-runner', ownerId: 'o1' } as never;
const TARGET = 'target-runner';

const PENDING_INSTALL: RunnerInstallState = { status: 'pending', engine: 'claude', command: null, message: null, mode: 'install' };
const PENDING_UPDATE: RunnerInstallState = { status: 'pending', engine: null, command: null, message: null, mode: 'update' };
const INSTALLING: RunnerInstallState = {
  status: 'installing', engine: 'claude', command: 'curl -fsSL https://claude.ai/install.sh | bash', message: null, mode: 'install',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = Record<string, any>;

/**
 * A controller over a Prisma that finds `target` (or nothing) and a RunnersService that records what it is
 * asked; the gate passes unless told.
 */
function makeController(target: Record<string, unknown> | null, refuse = false) {
  const seen: { findFirst?: Args; calls: unknown[][]; authorizations: unknown[][] } = { calls: [], authorizations: [] };
  const prisma = {
    runner: {
      findFirst: async (args: Args) => {
        seen.findFirst = args;
        return target;
      },
    },
  } as unknown as PrismaService;
  const runners = {
    startInstall: async (...args: unknown[]) => {
      seen.calls.push(['startInstall', ...args]);
      return PENDING_INSTALL;
    },
    startEngineUpdate: async (...args: unknown[]) => {
      seen.calls.push(['startEngineUpdate', ...args]);
      return PENDING_UPDATE;
    },
    getInstallState: async (...args: unknown[]) => {
      seen.calls.push(['getInstallState', ...args]);
      return INSTALLING;
    },
  } as unknown as RunnersService;
  const orchestration = {
    assert: async (...args: unknown[]) => {
      seen.authorizations.push(args);
      if (refuse) throw new ForbiddenException('orchestration is not enabled for this session');
      return 'session-1';
    },
  } as unknown as RunnerOrchestrationAuthorizer;
  return { controller: new RunnerEngineInstallController(prisma, runners, orchestration), seen };
}

/** A runner as the presence rule reads it: heard from `agoMs` ago, by its presence row. */
const heard = (agoMs: number, status = 'ONLINE') => ({ status, lastHeartbeatAt: null, presence: { lastBeatAt: new Date(Date.now() - agoMs) } });

/** The log lines, as whoever reads the apiserver's log sees them. */
function captureLog() {
  const lines: string[] = [];
  const original = Logger.prototype.log;
  Logger.prototype.log = function (message: unknown) {
    lines.push(String(message));
  } as never;
  return { lines, restore: () => (Logger.prototype.log = original) };
}

test('the gate comes first: a session that may not orchestrate starts, reads and finds nothing', async () => {
  const { controller, seen } = makeController(heard(5_000), true);
  await assert.rejects(
    controller.requestEngineInstall(CALLER, 'session-1', 'credential', TARGET, { engine: 'claude' }),
    ForbiddenException,
  );
  await assert.rejects(controller.engineInstallState(CALLER, 'session-1', 'credential', TARGET), ForbiddenException);
  assert.deepEqual(seen.authorizations, [
    [CALLER, 'session-1', 'credential'],
    [CALLER, 'session-1', 'credential'],
  ]);
  assert.equal(seen.findFirst, undefined);
  assert.deepEqual(seen.calls, []);
});

test("only the caller's own account: a runner it does not have is not found, and nothing starts", async () => {
  const { controller, seen } = makeController(null);
  await assert.rejects(
    controller.requestEngineInstall(CALLER, 'session-1', 'credential', TARGET, { engine: 'claude' }),
    (error: unknown) => error instanceof NotFoundException && error.message === 'runner not found',
  );
  assert.deepEqual(seen.findFirst!.where, { id: TARGET, ownerId: 'o1' }, 'looked up under the calling runner’s owner');
  assert.deepEqual(seen.calls, []);
});

test('a runner the presence rule reads offline is refused before anything starts, in the words the web uses', async () => {
  for (const [what, target, mode, words] of [
    ['signed off a moment ago', heard(5_000, 'OFFLINE'), 'install', 'Runner is offline — it can only install while connected'],
    ['ONLINE, but silent past the offline line', heard(RUNNER_OFFLINE_AFTER_MS + 5_000), 'install', 'Runner is offline — it can only install while connected'],
    ['never heard from', { status: 'ONLINE', lastHeartbeatAt: null, presence: null }, 'update', 'Runner is offline — it can only update while connected'],
  ] as const) {
    const { controller, seen } = makeController(target);
    await assert.rejects(
      controller.requestEngineInstall(CALLER, 'session-1', 'credential', TARGET, { engine: 'claude', mode }),
      (error: unknown) => error instanceof BadRequestException && error.message === words,
      what,
    );
    assert.deepEqual(seen.calls, [], `${what}: nothing started`);
  }
});

test("an install is the web's Install: startInstall for the caller's owner, its state answered, the asking session logged", async () => {
  const { lines, restore } = captureLog();
  try {
    const { controller, seen } = makeController(heard(5_000));
    const answer = await controller.requestEngineInstall(CALLER, 'session-1', 'credential', TARGET, { engine: 'claude' });
    assert.deepEqual(answer, PENDING_INSTALL);
    assert.deepEqual(seen.calls, [['startInstall', 'o1', TARGET, 'claude']]);
    // Read with the beats the presence rule reads, and nothing of a credential.
    assert.deepEqual(Object.keys(seen.findFirst!.select).sort(), ['lastHeartbeatAt', 'presence', 'status']);
    assert.deepEqual(lines, ['session session-1 (runner caller-runner) asked runner target-runner to install claude']);

    // `install` named is the same request as `install` left out.
    lines.length = 0;
    const named = makeController(heard(5_000));
    await named.controller.requestEngineInstall(CALLER, 'session-1', 'credential', TARGET, { engine: 'cursor', mode: 'install' });
    assert.deepEqual(named.seen.calls, [['startInstall', 'o1', TARGET, 'cursor']]);
  } finally {
    restore();
  }
});

test("an update is the web's Update engines: startEngineUpdate for the caller's owner, every engine on the machine", async () => {
  const { lines, restore } = captureLog();
  try {
    const { controller, seen } = makeController(heard(5_000));
    const answer = await controller.requestEngineInstall(CALLER, 'session-1', 'credential', TARGET, { engine: 'codex', mode: 'update' });
    assert.deepEqual(answer, PENDING_UPDATE);
    assert.deepEqual(seen.calls, [['startEngineUpdate', 'o1', TARGET]]);
    assert.deepEqual(lines, ['session session-1 (runner caller-runner) asked runner target-runner to update its engine CLIs (named codex)']);
  } finally {
    restore();
  }
});

test('a refusal from the relay itself is the answer, and logs no request', async () => {
  const { lines, restore } = captureLog();
  try {
    const { controller } = makeController(heard(5_000));
    const refusal = new BadRequestException('Antigravity needs Orbit runner 0.1.209 or newer — updates itself when idle');
    (controller as unknown as { runners: { startInstall: () => Promise<never> } }).runners.startInstall = async () => {
      throw refusal;
    };
    await assert.rejects(controller.requestEngineInstall(CALLER, 'session-1', 'credential', TARGET, { engine: 'antigravity' }), refusal);
    assert.deepEqual(lines, []);
  } finally {
    restore();
  }
});

test("the status is the web's install state, read for the caller's own account", async () => {
  const { controller, seen } = makeController(null);
  assert.deepEqual(await controller.engineInstallState(CALLER, 'session-1', 'credential', TARGET), INSTALLING);
  assert.deepEqual(seen.calls, [['getInstallState', 'o1', TARGET]]);
  assert.equal(seen.findFirst, undefined, 'no read of its own: getInstallState is the owner-scoped read the web route makes');
});
