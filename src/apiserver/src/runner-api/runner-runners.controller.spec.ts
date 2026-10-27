import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { RUNNER_OFFLINE_AFTER_MS } from '../runners/runner-presence';
import type { RunnerOrchestrationAuthorizer } from './runner-orchestration-authorizer';
import { RunnerRunnersController } from './runner-runners.controller';

const CALLER = { id: 'r1', ownerId: 'o1' } as never;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FindManyArgs = Record<string, any>;

/** A controller over a Prisma that hands back `rows` and records what it was asked; the gate passes unless told. */
function makeController(rows: unknown[], refuse = false) {
  const seen: { findMany?: FindManyArgs; authorizations: unknown[][] } = { authorizations: [] };
  const prisma = {
    runner: {
      findMany: async (args: FindManyArgs) => {
        seen.findMany = args;
        return rows;
      },
    },
  } as unknown as PrismaService;
  const orchestration = {
    assert: async (...args: unknown[]) => {
      seen.authorizations.push(args);
      if (refuse) throw new ForbiddenException('orchestration is not enabled for this session');
      return 'session-1';
    },
  } as unknown as RunnerOrchestrationAuthorizer;
  return { controller: new RunnerRunnersController(prisma, orchestration), seen };
}

const row = (extra: Record<string, unknown> = {}) => ({
  id: 'r1',
  name: 'build-box',
  displayName: null,
  status: 'ONLINE',
  version: '0.9.1',
  maxConcurrent: 4,
  lastHeartbeatAt: null,
  presence: null,
  capabilities: [],
  engines: null,
  accountNames: null,
  accountPauses: null,
  defaultRemoved: [],
  _count: { workspaces: 0 },
  ...extra,
});

test('the gate comes first: a refused session reads no runner', async () => {
  const { controller, seen } = makeController([row()], true);
  await assert.rejects(controller.listRunners(CALLER, 'session-1', 'credential'), ForbiddenException);
  assert.deepEqual(seen.authorizations, [[CALLER, 'session-1', 'credential']]);
  assert.equal(seen.findMany, undefined);
});

test("reads the caller's own account, in the web list's order, and never a credential column", async () => {
  const { controller, seen } = makeController([]);
  assert.deepEqual(await controller.listRunners(CALLER, 'session-1', 'credential'), []);
  const args = seen.findMany!;
  assert.deepEqual(args.where, { ownerId: 'o1' });
  assert.deepEqual(args.orderBy, [{ position: { sort: 'asc', nulls: 'last' } }, { enrolledAt: 'asc' }, { id: 'asc' }]);
  assert.deepEqual(args.select._count, { select: { workspaces: { where: { ownerId: 'o1', deletedAt: null } } } });
  for (const column of Object.keys(args.select)) {
    assert.doesNotMatch(column, /token|secret|hash|env$|key/i, `${column} is not read`);
  }
});

test('each runner: the whitelisted view, online by the presence rule, os and engines only when reported', async () => {
  const now = Date.now();
  const recent = new Date(now - 5_000);
  const { controller } = makeController([
    row({
      id: 'r1',
      displayName: 'Build box',
      lastHeartbeatAt: new Date(now - 10 * 60_000),
      presence: { lastBeatAt: recent },
      capabilities: ['runner-v1', 'os:darwin'],
      engines: [
        { engine: 'claude', installed: true, version: '2.1.0', auth: 'yes' },
        { engine: 'codex', installed: true, auth: 'maybe' },
        { engine: 'kimi', installed: false, auth: 'yes' },
      ],
      _count: { workspaces: 3 },
    }),
    // Silent for longer than the offline line, and never reported an OS or an engine.
    row({ id: 'r2', name: 'quiet', lastHeartbeatAt: new Date(now - RUNNER_OFFLINE_AFTER_MS - 1_000) }),
    // Signed off, though it beat a moment ago; it reported an engine, not installed.
    row({
      id: 'r3', name: 'signed-off', status: 'OFFLINE', presence: { lastBeatAt: recent },
      engines: [{ engine: 'claude', installed: false, auth: 'unknown' }],
    }),
  ]);
  const [box, quiet, signedOff] = (await controller.listRunners(CALLER, 'session-1', 'credential')) as Array<Record<string, unknown>>;
  assert.deepEqual(box, {
    id: 'r1',
    name: 'build-box',
    displayName: 'Build box',
    online: true,
    status: 'ONLINE',
    version: '0.9.1',
    lastHeartbeatAt: recent,
    maxConcurrent: 4,
    os: 'darwin',
    // Installed ones only; an answer the engine did not give reads `unknown`, as the web list has it.
    engines: [{ engine: 'claude', auth: 'yes' }, { engine: 'codex', auth: 'unknown' }],
    workspaceCount: 3,
  });
  assert.equal(quiet.online, false);
  assert.equal('os' in quiet, false);
  assert.equal('engines' in quiet, false, 'never reported: no engines key, which is not the same answer as none installed');
  assert.equal(signedOff.online, false);
  assert.deepEqual(signedOff.engines, [], 'reported, and nothing installed');
});
