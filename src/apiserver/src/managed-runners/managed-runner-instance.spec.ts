/**
 * Which instance of a managed runner may use its credential (managed-runner-instance.ts), offline:
 * the decision, the two runner guards that apply it to every runner-door request, the re-check where
 * a long poll hands out work, and the owner's credential rotation. The same paths run over HTTP
 * against a real database — heartbeat, claim, inbox, events and session leases — in
 * managed-runner-fencing.pg.spec.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ExecutionContext } from '@nestjs/common';
import {
  MANAGED_RUNNER_GENERATION_HEADER,
  MANAGED_RUNNER_INSTANCE_CAPABILITY,
  MANAGED_RUNNER_INSTANCE_FENCED,
  MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED,
  MANAGED_RUNNER_INSTANCE_PENDING,
  MANAGED_RUNNER_INSTANCE_REQUIRED,
  MANAGED_RUNNER_INSTANCE_SUPERSEDED,
  MANAGED_RUNNER_POD_UID_HEADER,
  MANAGED_RUNNER_ROTATE_REFUSED,
} from '@orbit/shared';

import { ACCOUNT_DISABLED } from '../auth/disabled-accounts';
import { sha256 } from '../common/crypto.util';
import { RunnerAuthGuard } from '../runner-api/runner-auth.guard';
import { RunnerSessionAuthGuard } from '../runner-api/runner-session-auth.guard';
import { RunnersService } from '../runners/runners.service';
import {
  managedRunnerInstanceClaimable,
  managedRunnerInstanceOffer,
  managedRunnerInstanceVerdict,
  reauthorizeManagedRunnerInstance,
  type ManagedRunnerInstanceRecord,
} from './managed-runner-instance';

const MAPPING = '0b6f5f6e-6f0a-4c5e-9b9e-2a3c4d5e6f70';
const POD = '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f';
const OTHER_POD = '9e8d7c6b-5a49-4382-9716-152433221100';

function mapping(overrides: Partial<ManagedRunnerInstanceRecord> = {}): ManagedRunnerInstanceRecord {
  return { id: MAPPING, generation: 3, podUid: POD, managementState: 'READY', ...overrides };
}

/** The headers a managed runner sends (runner-go managed_instance.go), with `overrides` applied. */
function headers(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const all: Record<string, string | undefined> = {
    'x-orbit-runner-capabilities': `session-worktree-ops-v1, ${MANAGED_RUNNER_INSTANCE_CAPABILITY}`,
    [MANAGED_RUNNER_GENERATION_HEADER]: '3',
    [MANAGED_RUNNER_POD_UID_HEADER]: POD,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

const verdictOf = (record: ManagedRunnerInstanceRecord, h: Record<string, string>) => managedRunnerInstanceVerdict(record, managedRunnerInstanceOffer(h));

function refused(record: ManagedRunnerInstanceRecord, h: Record<string, string>, status: number, code: string, label: string): void {
  const verdict = verdictOf(record, h);
  assert.equal(verdict.authorized, false, `${label}: authorized`);
  if (verdict.authorized) return;
  assert.equal(verdict.status, status, label);
  assert.equal(verdict.reason.code, code, label);
  assert.equal(verdict.reason.retryable, status === 503, label);
}

test('only the generation and Pod the manager recorded may use a managed runner’s credential', () => {
  assert.deepEqual(verdictOf(mapping(), headers()), { authorized: true, instance: { mappingId: MAPPING, generation: 3, podUid: POD } });
  assert.equal(verdictOf(mapping(), headers({ [MANAGED_RUNNER_POD_UID_HEADER]: POD.toUpperCase() })).authorized, true);
  for (const state of ['STARTING', 'FAILED', 'DRAINING'] as const) {
    assert.equal(verdictOf(mapping({ managementState: state }), headers()).authorized, true, `the recorded instance while ${state}`);
  }

  // A predecessor, whatever else it says.
  refused(mapping(), headers({ [MANAGED_RUNNER_GENERATION_HEADER]: '2' }), 403, MANAGED_RUNNER_INSTANCE_SUPERSEDED, 'the previous generation');
  refused(mapping(), headers({ [MANAGED_RUNNER_GENERATION_HEADER]: '2', [MANAGED_RUNNER_POD_UID_HEADER]: OTHER_POD }), 403, MANAGED_RUNNER_INSTANCE_SUPERSEDED, 'the previous generation’s Pod');
  // Another Pod of this generation, or a generation never issued.
  refused(mapping(), headers({ [MANAGED_RUNNER_POD_UID_HEADER]: OTHER_POD }), 403, MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED, 'another Pod');
  refused(mapping(), headers({ [MANAGED_RUNNER_GENERATION_HEADER]: '4' }), 403, MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED, 'a later generation');
  // No instance while fencing or being deleted — the recorded one included.
  for (const state of ['FENCING', 'DELETING', 'DELETED'] as const) {
    refused(mapping({ managementState: state }), headers(), 403, MANAGED_RUNNER_INSTANCE_FENCED, state);
  }
  // Not recorded yet: wait, not stop.
  refused(mapping({ podUid: null, managementState: 'STARTING' }), headers(), 503, MANAGED_RUNNER_INSTANCE_PENDING, 'before the manager records the Pod');
  // Without the protocol: an older runner, or a copy of the credential elsewhere.
  refused(mapping(), {}, 403, MANAGED_RUNNER_INSTANCE_REQUIRED, 'no instance at all');
  refused(mapping(), headers({ 'x-orbit-runner-capabilities': 'session-worktree-ops-v1' }), 403, MANAGED_RUNNER_INSTANCE_REQUIRED, 'not declared');
  refused(mapping(), headers({ [MANAGED_RUNNER_GENERATION_HEADER]: undefined }), 403, MANAGED_RUNNER_INSTANCE_REQUIRED, 'no generation');
  refused(mapping(), headers({ [MANAGED_RUNNER_POD_UID_HEADER]: undefined }), 403, MANAGED_RUNNER_INSTANCE_REQUIRED, 'no Pod UID');
  refused(mapping(), headers({ [MANAGED_RUNNER_GENERATION_HEADER]: '03' }), 403, MANAGED_RUNNER_INSTANCE_REQUIRED, 'a malformed generation');
  refused(mapping(), headers({ [MANAGED_RUNNER_POD_UID_HEADER]: 'mr-pod' }), 403, MANAGED_RUNNER_INSTANCE_REQUIRED, 'a malformed Pod UID');
});

test('work is handed out only to an instance still authorized and not draining', () => {
  const instance = { mappingId: MAPPING, generation: 3, podUid: POD };
  assert.equal(managedRunnerInstanceClaimable(mapping(), instance), true);
  assert.equal(managedRunnerInstanceClaimable(mapping({ managementState: 'DRAINING' }), instance), false, 'draining');
  assert.equal(managedRunnerInstanceClaimable(mapping({ managementState: 'FENCING' }), instance), false, 'fenced since the poll began');
  assert.equal(managedRunnerInstanceClaimable(mapping({ generation: 4, podUid: null }), instance), false, 'superseded since the poll began');
  assert.equal(managedRunnerInstanceClaimable(mapping({ podUid: OTHER_POD }), instance), false, 'another Pod recorded');
  assert.equal(managedRunnerInstanceClaimable(null, instance), false, 'no mapping');
  assert.equal(managedRunnerInstanceClaimable(mapping({ id: OTHER_POD }), instance), false, 'another mapping');
});

test('a long poll’s later rounds re-read the mapping: a fenced instance is refused there too', async () => {
  const instance = { mappingId: MAPPING, generation: 3, podUid: POD };
  const reading = (row: ManagedRunnerInstanceRecord | null) => ({ managedRunner: { findUnique: async () => row } });
  await reauthorizeManagedRunnerInstance(reading(mapping()) as never, instance);
  await assert.rejects(reauthorizeManagedRunnerInstance(reading(mapping({ managementState: 'FENCING' })) as never, instance),
    (e: any) => e.getStatus() === 403 && e.getResponse().code === MANAGED_RUNNER_INSTANCE_FENCED);
  await assert.rejects(reauthorizeManagedRunnerInstance(reading(mapping({ generation: 4, podUid: null })) as never, instance),
    (e: any) => e.getStatus() === 403 && e.getResponse().code === MANAGED_RUNNER_INSTANCE_SUPERSEDED);
  await assert.rejects(reauthorizeManagedRunnerInstance(reading(null) as never, instance), (e: any) => e.getStatus() === 403);
});

/**
 * A database with one runner credential, its owner's account state (RUNNER_OWNER_STATE — read on
 * every request, so a change to `account` applies to the next one) and, for a managed runner, its
 * mapping.
 */
function database(managed: ManagedRunnerInstanceRecord | null, account: { disabledAt: Date | null } = { disabledAt: null }) {
  const lookups: unknown[] = [];
  return {
    lookups,
    prisma: {
      runner: {
        findFirst: async ({ where }: { where: { tokenHash: string } }) =>
          where.tokenHash === sha256('runner-secret') ? { id: 'runner-1', ownerId: 'owner-1', owner: { disabledAt: account.disabledAt } } : null,
      },
      managedRunner: {
        findUnique: async (query: unknown) => {
          lookups.push(query);
          return managed;
        },
      },
    },
  };
}

function context(h: Record<string, string>): { ctx: ExecutionContext; req: Record<string, any> } {
  const req: Record<string, any> = { headers: { authorization: 'Bearer runner-secret', ...h } };
  return { ctx: { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext, req };
}

const guards = (prisma: unknown) => [
  ['RunnerAuthGuard', new RunnerAuthGuard(prisma as never)],
  ['RunnerSessionAuthGuard', new RunnerSessionAuthGuard(prisma as never, { verify: async () => null } as never)],
] as const;

test('the runner guards: a self-managed runner keeps its protocol, whatever it sends', async () => {
  const { prisma, lookups } = database(null);
  for (const [name, guard] of guards(prisma)) {
    for (const h of [{}, headers(), headers({ [MANAGED_RUNNER_GENERATION_HEADER]: '1' })]) {
      const { ctx, req } = context(h);
      assert.equal(await guard.canActivate(ctx), true, name);
      assert.equal(req.runner.id, 'runner-1');
      assert.equal(req.managedRunnerInstance, undefined, `${name}: no instance for a self-managed runner`);
    }
  }
  assert.deepEqual(lookups[0], {
    where: { runnerId: 'runner-1' },
    select: { id: true, generation: true, podUid: true, managementState: true },
  }, 'one read of the mapping by its unique runner key, and no write');
});

test('the runner guards: a managed runner’s credential is accepted from its authorized instance only', async () => {
  const { prisma } = database(mapping());
  for (const [name, guard] of guards(prisma)) {
    const ok = context(headers());
    assert.equal(await guard.canActivate(ok.ctx), true, name);
    assert.deepEqual(ok.req.managedRunnerInstance, { mappingId: MAPPING, generation: 3, podUid: POD });
    for (const [h, status, code] of [
      [headers({ [MANAGED_RUNNER_GENERATION_HEADER]: '2' }), 403, MANAGED_RUNNER_INSTANCE_SUPERSEDED],
      [headers({ [MANAGED_RUNNER_POD_UID_HEADER]: OTHER_POD }), 403, MANAGED_RUNNER_INSTANCE_NOT_AUTHORIZED],
      [{}, 403, MANAGED_RUNNER_INSTANCE_REQUIRED],
    ] as const) {
      const refusedCall = context(h);
      await assert.rejects(guard.canActivate(refusedCall.ctx), (e: any) => e.getStatus() === status && e.getResponse().code === code, `${name}: ${code}`);
      assert.equal(refusedCall.req.runner, undefined, `${name}: a refused request reaches no handler`);
    }
  }
  const { prisma: fencing } = database(mapping({ managementState: 'FENCING' }));
  for (const [name, guard] of guards(fencing)) {
    await assert.rejects(guard.canActivate(context(headers()).ctx), (e: any) => e.getResponse().code === MANAGED_RUNNER_INSTANCE_FENCED, name);
  }
  const { prisma: pending } = database(mapping({ podUid: null, managementState: 'STARTING' }));
  for (const [name, guard] of guards(pending)) {
    await assert.rejects(guard.canActivate(context(headers()).ctx), (e: any) => e.getStatus() === 503 && e.getResponse().retryable === true, name);
  }
});

test('a disabled account’s managed runner is refused 403 ACCOUNT_DISABLED, even from its authorized instance, on both guards; enabled again, that instance is served', async () => {
  const account = { disabledAt: new Date('2026-10-09T05:00:00.000Z') as Date | null };
  const { prisma, lookups } = database(mapping(), account);
  for (const [name, guard] of guards(prisma)) {
    // The authorized instance, a predecessor and an older runner alike: the account answers first.
    for (const h of [headers(), headers({ [MANAGED_RUNNER_GENERATION_HEADER]: '2' }), {}]) {
      const refusedCall = context(h);
      await assert.rejects(
        guard.canActivate(refusedCall.ctx),
        (e: any) => e.getStatus() === 403 && e.getResponse().code === ACCOUNT_DISABLED,
        `${name}: ${JSON.stringify(h)}`,
      );
      assert.equal(refusedCall.req.runner, undefined, `${name}: a refused request reaches no handler`);
    }
  }
  assert.equal(lookups.length, 0, 'refused before the managed instance is even looked up');

  // An administrator enables the account again: the authorized instance is served, nothing else.
  account.disabledAt = null;
  for (const [name, guard] of guards(prisma)) {
    const served = context(headers());
    assert.equal(await guard.canActivate(served.ctx), true, name);
    assert.deepEqual(served.req.managedRunnerInstance, { mappingId: MAPPING, generation: 3, podUid: POD });
    assert.equal(served.req.runner.owner, undefined, `${name}: the account state is not handed on`);
    await assert.rejects(
      guard.canActivate(context(headers({ [MANAGED_RUNNER_GENERATION_HEADER]: '2' })).ctx),
      (e: any) => e.getResponse().code === MANAGED_RUNNER_INSTANCE_SUPERSEDED,
      `${name}: a predecessor is still refused`,
    );
  }
});

test('the owner cannot rotate a managed runner’s credential; a self-managed runner’s rotates as before', async () => {
  const writes: unknown[] = [];
  const service = (managed: boolean) =>
    new RunnersService({
      runner: {
        findFirst: async () => ({ id: 'runner-1', ownerId: 'owner-1' }),
        update: async (query: unknown) => {
          writes.push(query);
          return {};
        },
      },
      managedRunner: { findUnique: async () => (managed ? { id: MAPPING } : null) },
    } as never);
  await assert.rejects(service(true).rotateToken('owner-1', 'runner-1'),
    (e: any) => e.getStatus() === 409 && e.getResponse().code === MANAGED_RUNNER_ROTATE_REFUSED);
  assert.deepEqual(writes, [], 'nothing was written for a managed runner');
  const rotated = await service(false).rotateToken('owner-1', 'runner-1');
  assert.equal(typeof rotated.token, 'string');
  assert.equal(writes.length, 1);
});
