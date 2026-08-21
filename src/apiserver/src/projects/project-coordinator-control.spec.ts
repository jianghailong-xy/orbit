import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { base62ToUuid, uuidToBase62 } from '@orbit/shared';
import { ProjectsService } from './projects.service';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import {
  COORDINATOR_DISABLED_CODE,
  PROJECT_SETTLED_CODE,
  STALE_CONFIG_REVISION_CODE,
} from './project-coordinator-status';

/**
 * The control half of unit 20: what a write to this project's coordination is allowed to be.
 *
 * Two rules, and every test here is one of them:
 *
 *  - **Stale is refused, and nothing is written.** `expectedConfigRevision` is compared under the
 *    same row lock as the write it guards, inside the same transaction, so "refused" and "rolled
 *    back" are one outcome. Last-write-wins on the authorization set is not a merge — it is one
 *    person silently undoing another's revoke — and the revision is what turns "I did not see your
 *    change" into a refusal instead of an outcome.
 *  - **Over-reach is refused, and said so.** The runner door carries no authorization field and no
 *    manual trigger: an agent that could write them would be granting itself what it was refused,
 *    and one that could enqueue a signal attributed to USER would be driving its own coordinator —
 *    which is exactly what MANUAL means it may not do.
 *
 * And one compatibility rule, which is why both new fields are optional: a client that sends
 * neither behaves exactly as it did before they existed.
 */

const OWNER = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const PROJECT = '019fcbf3-0fa8-7f83-9302-46b25389cb16';
const TRIGGER = '019fd557-68b2-7fb2-bef0-9fb1cf06abb2';

interface Row {
  status?: string;
  coordinator_enabled?: boolean;
  config_revision?: bigint;
  automation_policy?: string;
}

/** What the fake recorded: which raw statements ran, and whether the project row was written. */
interface Trace {
  statements: string[];
  updates: unknown[];
  values: unknown[][];
}

function sqlText(arg: unknown): string {
  const parts = (arg as { strings?: readonly string[] })?.strings ?? (arg as readonly string[]);
  return Array.isArray(parts) ? parts.join(' ') : String(arg);
}

function service(row: Row | null, trace: Trace): ProjectsService {
  const locked = row === null ? [] : [{
    status: row.status ?? 'OPEN',
    coordinator_enabled: row.coordinator_enabled ?? true,
    config_revision: row.config_revision ?? 7n,
    automation_policy: row.automation_policy ?? 'GUARDED_AUTO',
  }];
  const tx = {
    $queryRaw: async (arg: unknown, ...rest: unknown[]) => {
      const sql = sqlText(arg);
      trace.statements.push(sql);
      trace.values.push(rest);
      if (sql.includes('FROM "project_event"')) {
        return [{
          id: '019fd08f-fd17-7e93-93fb-0f6989da8af6',
          occurrences: 1,
          occurredAt: new Date('2026-08-20T12:00:00.000Z'),
          lastAt: new Date('2026-08-20T12:00:00.000Z'),
          consumedAt: null,
          nextAttemptAt: null,
        }];
      }
      return locked;
    },
    $executeRaw: async (arg: unknown, ...rest: unknown[]) => {
      trace.statements.push(sqlText(arg));
      trace.values.push(rest);
      return 1;
    },
    project: {
      update: async (args: unknown) => {
        trace.updates.push(args);
        return { id: PROJECT, members: [], runtime: null };
      },
    },
  };
  const prisma = {
    project: { findFirst: async () => (row === null ? null : { id: PROJECT, coordinatorEnabled: true }) },
    $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  };
  return new ProjectsService(prisma as never, {} as never);
}

function trace(): Trace {
  return { statements: [], updates: [], values: [] };
}

/** The typed body a 409 from this surface carries. */
function conflict(error: unknown): Record<string, unknown> {
  assert.ok(error instanceof ConflictException, `expected a 409, got ${error}`);
  return error.getResponse() as Record<string, unknown>;
}

// ── Stale writes ──────────────────────────────────────────────────────────────────────────────

test('an update composed against an older revision is refused, and nothing is written', async () => {
  const t = trace();
  const error = await service({ config_revision: 9n }, t)
    .update(OWNER, PROJECT, { maxConcurrentTasks: 5, expectedConfigRevision: '7' })
    .then(() => null, (e) => e);
  const body = conflict(error);
  assert.equal(body.code, STALE_CONFIG_REVISION_CODE);
  // Both numbers, so the client can re-read and decide rather than guess what moved.
  assert.equal(body.expectedConfigRevision, '7');
  assert.equal(body.configRevision, '9');
  assert.deepEqual(t.updates, [], 'a refused write must not have written anything');
});

test('the revision is compared AFTER the row lock, not before it', async () => {
  const t = trace();
  await service({ config_revision: 7n }, t)
    .update(OWNER, PROJECT, { maxConcurrentTasks: 5, expectedConfigRevision: '7' });
  // The lock is what makes the comparison and the write one ordering rather than an interleaving:
  // whichever of two writers commits first, the other one sees it.
  assert.match(t.statements[0], /FOR NO KEY UPDATE/);
  assert.match(t.statements[0], /"config_revision"/);
  assert.equal(t.updates.length, 1);
});

test('a matching revision goes through, and the write still bumps it', async () => {
  const t = trace();
  await service({ config_revision: 7n }, t)
    .update(OWNER, PROJECT, { maxConcurrentTasks: 5, expectedConfigRevision: '7' });
  const [args] = t.updates as Array<{ data: Record<string, unknown> }>;
  assert.deepEqual(args.data.configRevision, { increment: 1 });
});

test('an update that sends no revision behaves exactly as it did before the field existed', async () => {
  const t = trace();
  await service({ config_revision: 9n }, t).update(OWNER, PROJECT, { maxConcurrentTasks: 5 });
  assert.equal(t.updates.length, 1, 'omitting the fence must not start refusing old clients');
});

test('a prose-only edit is fenced too — the revision is a claim about the project, not the field set', async () => {
  const t = trace();
  const error = await service({ config_revision: 9n }, t)
    .update(OWNER, PROJECT, { title: 'renamed', expectedConfigRevision: '7' })
    .then(() => null, (e) => e);
  assert.equal(conflict(error).code, STALE_CONFIG_REVISION_CODE);
  assert.deepEqual(t.updates, []);
});

// ── Manual trigger ────────────────────────────────────────────────────────────────────────────

test('a manual trigger commits one durable signal and starts nothing itself', async () => {
  const t = trace();
  const result = await service({}, t).triggerCoordinator(OWNER, PROJECT, { triggerId: TRIGGER });
  assert.equal(result.accepted, true);
  // The authoritative producer, called rather than reimplemented — every Project event is enqueued
  // by this function at the database write (migration 0117).
  assert.ok(
    t.statements.some((sql) => sql.includes('project_event_manual_trigger')),
    'the trigger must go through the event producer, not a hand-written INSERT',
  );
  // Nothing else: no session, no action, no turn. The pass runs afterwards, under its own gates.
  assert.deepEqual(t.updates, []);
});

test('the trigger id comes back in Base62, and a caller that named none is given one', async () => {
  const named = await service({}, trace()).triggerCoordinator(OWNER, PROJECT, { triggerId: TRIGGER });
  assert.equal(named.triggerId, uuidToBase62(TRIGGER));
  const t = trace();
  const anonymous = await service({}, t).triggerCoordinator(OWNER, PROJECT);
  assert.doesNotMatch(anonymous.triggerId, /-/, 'an allocated trigger id must be Base62 too');
  // Allocated, not omitted: a caller can retry with it and get the same request rather than a
  // second run.
  assert.equal(base62ToUuid(anonymous.triggerId).length, 36);
});

test('the same trigger id twice is reported as one request, not two runs', async () => {
  const first = await service({}, trace()).triggerCoordinator(OWNER, PROJECT, { triggerId: TRIGGER });
  assert.equal(first.deduplicated, false);
  assert.equal(first.occurrences, 1);
  // `occurrences` is what the outbox upsert bumps when the key is already pending, and reading it
  // back is how a client retrying a timed-out POST is told "already queued" rather than being
  // given a second coordination run.
  const second = await serviceWithOccurrences(2)
    .triggerCoordinator(OWNER, PROJECT, { triggerId: TRIGGER });
  assert.equal(second.deduplicated, true);
  assert.equal(second.occurrences, 2);
});

function serviceWithOccurrences(occurrences: number): ProjectsService {
  const tx = {
    $queryRaw: async (arg: unknown) => (sqlText(arg).includes('FROM "project_event"')
      ? [{
        id: '019fd08f-fd17-7e93-93fb-0f6989da8af6',
        occurrences,
        occurredAt: new Date(),
        lastAt: new Date(),
        consumedAt: null,
        nextAttemptAt: null,
      }]
      : [{
        status: 'OPEN',
        coordinator_enabled: true,
        config_revision: 7n,
        automation_policy: 'MANUAL',
      }]),
    $executeRaw: async () => 1,
  };
  return new ProjectsService(
    { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as never,
    {} as never,
  );
}

test('a MANUAL project is exactly where a manual trigger is meant to work', async () => {
  const result = await serviceWithOccurrences(1).triggerCoordinator(OWNER, PROJECT);
  assert.equal(result.automationPolicy, 'MANUAL');
  assert.equal(result.accepted, true);
});

test('a settled project refuses the trigger rather than queueing one that never runs', async () => {
  const t = trace();
  const error = await service({ status: 'DONE' }, t)
    .triggerCoordinator(OWNER, PROJECT)
    .then(() => null, (e) => e);
  assert.equal(conflict(error).code, PROJECT_SETTLED_CODE);
  assert.equal(
    t.statements.some((sql) => sql.includes('project_event_manual_trigger')),
    false,
    'nothing may be enqueued for a project whose events would be discarded',
  );
});

test('a switched-off coordinator refuses the trigger, and says how to turn it on', async () => {
  const t = trace();
  const error = await service({ coordinator_enabled: false }, t)
    .triggerCoordinator(OWNER, PROJECT)
    .then(() => null, (e) => e);
  const body = conflict(error);
  assert.equal(body.code, COORDINATOR_DISABLED_CODE);
  assert.match(String(body.requiredAction), /coordinatorEnabled/);
  assert.equal(t.statements.some((sql) => sql.includes('project_event_manual_trigger')), false);
});

test('a stale trigger is refused before the signal, not after it', async () => {
  const t = trace();
  const error = await service({ config_revision: 9n }, t)
    .triggerCoordinator(OWNER, PROJECT, { expectedConfigRevision: '7' })
    .then(() => null, (e) => e);
  assert.equal(conflict(error).code, STALE_CONFIG_REVISION_CODE);
  assert.equal(t.statements.some((sql) => sql.includes('project_event_manual_trigger')), false);
});

test('another account’s project is a 404, and the owner is in the query that decides', async () => {
  const t = trace();
  await assert.rejects(service(null, t).triggerCoordinator(OWNER, PROJECT), /project not found/);
  assert.ok(t.values[0].includes(OWNER), 'the locking read must be scoped by owner');
});

// ── The machine door ──────────────────────────────────────────────────────────────────────────

test('the runner door refuses every authorization field, by name', () => {
  const refuse = (dto: Record<string, unknown>) => {
    try {
      (RunnerProjectsController as unknown as {
        refuseGovernance: (d: unknown) => void;
      }).refuseGovernance(dto);
      return null;
    } catch (e) {
      return e;
    }
  };
  for (const field of [...ProjectsService.AUTHORIZATION_FIELDS, 'coordinatorAgentId']) {
    const error = refuse({ [field]: field === 'coordinatorEnabled' ? true : 1 });
    assert.ok(error instanceof ForbiddenException, `${field} must be refused over the agent door`);
    // Refused BY NAME rather than dropped: a silently ignored field reads to the caller — a model
    // that will go on to act as though the write happened — as a write that went through.
    assert.match(String((error as ForbiddenException).message), new RegExp(field));
  }
});

test('the runner door still carries the fence, which grants nothing and only refuses', () => {
  assert.doesNotThrow(() => (RunnerProjectsController as unknown as {
    refuseGovernance: (d: unknown) => void;
  }).refuseGovernance({ title: 'x', expectedConfigRevision: '7' }));
});
