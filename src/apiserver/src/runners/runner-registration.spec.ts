import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaService } from '../prisma/prisma.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnersService } from './runners.service';

/**
 * Neither registration door speaks for the machine. A runner's status is what it last said about itself and its last
 * beat is its own, so a browser approval and a token registration write neither: a machine not yet running reads
 * offline, not online on a stamp nobody beat (the first workspace rehearsal's F1, task 34pLtXwjTWRAHNTdIy9Kz).
 * Held here as well as in runner-device-enrollment.pg.spec.ts because the merge check runs these.
 */

const OWNER = '11111111-1111-4111-8111-111111111111';
const RUNNER_ID = '22222222-2222-4222-8222-222222222222';
const FUTURE = new Date(Date.now() + 600_000);

type Row = Record<string, unknown>;

function runnerWrites(existing: Row | null) {
  const creates: Row[] = [];
  const updates: Row[] = [];
  const runner = {
    findFirst: async () => existing,
    create: async ({ data }: { data: Row }) => {
      creates.push(data);
      return { id: RUNNER_ID, ...data };
    },
    update: async ({ data }: { data: Row }) => {
      updates.push(data);
      return { id: RUNNER_ID, ...data };
    },
  };
  return { runner, creates, updates };
}

function approvalHarness(existing: Row | null) {
  const writes = runnerWrites(existing);
  const enrollment = {
    id: 'enrollment', status: 'PENDING', name: 'lab-mac', hostname: 'lab-mac', labels: [], maxConcurrent: 4, version: '0.1.250',
    workDir: '/home/orbit/code/app', approvedById: null, expiresAt: FUTURE,
  };
  const prisma = {
    runner: writes.runner,
    deviceEnrollment: {
      findUnique: async () => enrollment,
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
    },
  } as unknown as PrismaService;
  return { service: new RunnersService(prisma), ...writes };
}

function tokenHarness(existing: Row | null) {
  const writes = runnerWrites(existing);
  const prisma = {
    runner: writes.runner,
    enrollmentToken: {
      findUnique: async () => ({ id: 'token', ownerId: OWNER, usedAt: null, expiresAt: null }),
      update: async () => ({}),
    },
  } as never;
  const controller = new RunnerApiController(
    prisma,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { controller, ...writes };
}

const SAYS_NOTHING = (data: Row) => {
  assert.equal('status' in data, false, 'a registration writes no status');
  assert.equal('lastHeartbeatAt' in data, false, 'a registration writes no beat');
};

test('approving mints a runner that has said nothing yet: the column defaults leave it OFFLINE, never heard from', async () => {
  const h = approvalHarness(null);
  await h.service.approveDeviceEnrollment(OWNER, 'ABCD-1234');
  assert.equal(h.creates.length, 1);
  SAYS_NOTHING(h.creates[0]);
  assert.equal(h.creates[0].registerDir, '/home/orbit/code/app');
});

test('approving a machine again re-issues its credential and leaves what its beats said', async () => {
  const h = approvalHarness({ id: RUNNER_ID, status: 'ONLINE' });
  await h.service.approveDeviceEnrollment(OWNER, 'ABCD-1234');
  assert.equal(h.updates.length, 1);
  SAYS_NOTHING(h.updates[0]);
  assert.equal(typeof h.updates[0].tokenHash, 'string');
});

test('a token registration says as little, for a new machine and one registered again', async () => {
  for (const existing of [null, { id: RUNNER_ID, status: 'ONLINE' }]) {
    const h = tokenHarness(existing);
    await h.controller.register({ enrollmentToken: 'token', name: 'lab-mac', hostname: 'lab-mac', workDir: '/srv/build' } as never);
    const [data] = existing ? h.updates : h.creates;
    SAYS_NOTHING(data);
    assert.equal(data.registerDir, '/srv/build');
  }
});
