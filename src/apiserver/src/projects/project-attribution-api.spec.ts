import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { TasksController } from '../tasks/tasks.controller';
import { ProjectsController } from './projects.controller';
import { ProjectAttributionService } from './project-attribution.service';

/**
 * Unit L7, the read face: what the queries hand the pure derivation.
 *
 * The pure spec proves the derivation. This proves the layer between it and the database — the
 * part where an owner filter can be forgotten, a BigInt can reach JSON, a date can be handed over
 * as a `Date` the wire has no spelling for, and a crossing's state can be turned into advice the
 * server would not actually give.
 */

const OWNER = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const PROJECT = '019fcbf3-0fa8-7f83-9302-46b25389cb16';
const OTHER_PROJECT = '019fcbf3-0fa8-7f83-9302-46b25389cb17';
const TASK = '019fcda0-d021-72a2-a914-2f4de38f469c';
const SOURCE_TASK = '019fcda0-d021-72a2-a914-2f4de38f469d';
const SOURCE_SESSION = '019fcda0-d021-72a2-a914-2f4de38f469e';
const BLOCKER = '019fcda0-d021-72a2-a914-2f4de38f4611';
const HANDOFF = '019fcda0-d021-72a2-a914-2f4de38f4612';

const PROJECT_ROW = { id: PROJECT, title: 'Coordinator control loop', status: 'OPEN' };

type Recorded = { handoff?: unknown; blockers?: unknown };

function service(over: {
  task?: unknown;
  handoff?: unknown;
  blockers?: unknown[];
  recorded?: Recorded;
} = {}): ProjectAttributionService {
  const recorded = over.recorded ?? {};
  const prisma = {
    task: {
      findFirst: async () =>
        over.task === undefined
          ? {
              id: TASK,
              projectId: PROJECT,
              project: PROJECT_ROW,
              triggerEvent: 'session.transcript',
              discoveredFromProject: { id: OTHER_PROJECT, title: 'Somewhere else', status: 'DONE' },
              sourceTask: { id: SOURCE_TASK, title: 'the task that noticed it' },
              sourceSession: { id: SOURCE_SESSION, title: null },
            }
          : over.task,
    },
    projectHandoffApproval: {
      findFirst: async (args: unknown) => {
        recorded.handoff = args;
        return over.handoff ?? null;
      },
    },
    projectBlocker: {
      findMany: async (args: unknown) => {
        recorded.blockers = args;
        return over.blockers ?? [];
      },
    },
  };
  return new ProjectAttributionService(prisma as never);
}

test('L7-API1: a task nobody owns is a 404, not an empty boundary', async () => {
  await assert.rejects(
    () => service({ task: null }).read(OWNER, TASK),
    (e: unknown) => e instanceof NotFoundException,
  );
});

test('L7-API2: every hanging read is constrained by owner or by the owning project', async () => {
  const recorded: Recorded = {};
  await service({ recorded }).read(OWNER, TASK);
  assert.equal((recorded.handoff as { where: { ownerId: string } }).where.ownerId, OWNER);
  assert.deepEqual((recorded.blockers as { where: unknown }).where, {
    subjectType: 'TASK', subjectId: TASK, resolvedAt: null, project: { ownerId: OWNER },
  });
});

test('L7-API3: a task filed under no project still has an attribution boundary', async () => {
  const view = await service({
    task: {
      id: TASK, projectId: null, project: null, triggerEvent: null,
      discoveredFromProject: null, sourceTask: null, sourceSession: null,
    },
  }).read(OWNER, TASK);
  assert.equal(view.owning, null);
  assert.equal(view.owningAbsentReason, 'FILED_UNDER_NO_PROJECT');
});

test('L7-API4: the provenance is labelled evidence and names what noticed the work', async () => {
  const view = await service().read(OWNER, TASK);
  assert.equal(view.owning?.projectId, PROJECT);
  assert.equal(view.discovery.project?.projectId, OTHER_PROJECT);
  assert.equal(view.discovery.authority, 'EVIDENCE_ONLY');
  assert.equal(view.discovery.triggerEvent, 'session.transcript');
  assert.equal(view.discovery.task?.title, 'the task that noticed it');
});

test('L7-API6: a pending crossing carries L1s code and the rules own required action', async () => {
  const view = await service({
    handoff: {
      id: HANDOFF,
      kind: 'FILE_TASK',
      state: 'PENDING',
      subjectTaskId: TASK,
      crossingKey: 'c'.repeat(64),
      requestedAt: new Date('2026-08-22T00:00:00.000Z'),
      decidedAt: null,
      expiresAt: new Date('2026-08-29T00:00:00.000Z'),
      fromProject: PROJECT_ROW,
      toProject: { id: OTHER_PROJECT, title: 'Somewhere else', status: 'OPEN' },
    },
  }).read(OWNER, TASK);
  assert.equal(view.crossing?.code, 'APPROVAL_PENDING');
  assert.equal(view.crossing?.requiredAction, 'AWAIT_HANDOFF_APPROVAL');
  assert.equal(view.crossing?.from?.title, 'Coordinator control loop');
  assert.equal(view.crossing?.to?.title, 'Somewhere else');
  assert.equal(typeof view.crossing?.requestedAt, 'string', 'a Date has no wire spelling');
  assert.equal(view.crossing?.decidedAt, null);
});

test('L7-API7: an answered crossing stops refusing anything', async () => {
  for (const state of ['APPROVED', 'APPLIED'] as const) {
    const view = await service({
      handoff: {
        id: HANDOFF, kind: 'MOVE_TASK', state, subjectTaskId: TASK,
        crossingKey: 'c'.repeat(64),
        requestedAt: new Date(), decidedAt: new Date(), expiresAt: null,
        fromProject: PROJECT_ROW, toProject: PROJECT_ROW,
      },
    }).read(OWNER, TASK);
    assert.equal(view.crossing?.state, state);
    assert.equal(view.crossing?.code, null, `${state} is not a live refusal`);
    assert.equal(view.crossing?.requiredAction, null);
  }
});

test('L7-API8: a denied crossing says to file it at home, not to keep waiting', async () => {
  const view = await service({
    handoff: {
      id: HANDOFF, kind: 'FILE_TASK', state: 'DENIED', subjectTaskId: TASK,
      crossingKey: 'c'.repeat(64),
      requestedAt: new Date(), decidedAt: new Date(), expiresAt: null,
      fromProject: PROJECT_ROW, toProject: PROJECT_ROW,
    },
  }).read(OWNER, TASK);
  assert.equal(view.crossing?.code, 'APPROVAL_DENIED');
  assert.equal(view.crossing?.requiredAction, 'FILE_IN_OWN_PROJECT_OR_REQUEST_HANDOFF');
});

test('L7-API9: only an ATTRIBUTION blocker is reported as one', async () => {
  const merge = {
    id: BLOCKER, kind: 'MERGE_CONFLICT', owner: 'COORDINATOR',
    requiredAction: 'Resolve the conflict.', nextCheckAt: new Date(),
    detail: { refusalCode: 'MERGE_CONFLICT' }, lastSeenAt: new Date(),
  };
  assert.equal((await service({ blockers: [merge] }).read(OWNER, TASK)).blocker, null);
  assert.equal(
    (await service({ blockers: [merge] }).read(OWNER, TASK)).blockerAbsentReason,
    'NOTHING_BLOCKING_ATTRIBUTION',
  );

  const unmapped = {
    ...merge,
    kind: 'AWAITING_USER_INPUT',
    owner: 'USER',
    requiredAction: 'Say which project owns this work.',
    detail: { refusalCode: 'UNMAPPED_PROJECT_WORK' },
  };
  // Newest first, and the merge conflict is not skipped because it is older — it is skipped
  // because it is not about attribution at all.
  const view = await service({ blockers: [merge, unmapped] }).read(OWNER, TASK);
  assert.equal(view.blocker?.code, 'UNMAPPED_PROJECT_WORK');
  assert.equal(view.blocker?.kind, 'AWAITING_USER_INPUT');
  assert.equal(view.blocker?.owner, 'USER');
  assert.equal(typeof view.blocker?.nextCheckAt, 'string');
});

test('L7-API10: a blocker whose detail says nothing is not promoted into one', async () => {
  for (const detail of [null, {}, { refusalCode: 42 }, 'AWAITING_USER_INPUT']) {
    const view = await service({
      blockers: [{
        id: BLOCKER, kind: 'AWAITING_USER_INPUT', owner: 'USER',
        requiredAction: 'x', nextCheckAt: new Date(), detail, lastSeenAt: new Date(),
      }],
    }).read(OWNER, TASK);
    assert.equal(view.blocker, null, `detail ${JSON.stringify(detail)} names no refusal code`);
  }
});

// ── The doors, as routes ──────────────────────────────────────────────────────────────────────

/**
 * The user-facing surface, by path and verb.
 *
 * Asserted from metadata rather than by booting the app because what can silently go wrong here is
 * spelling, and a route nobody can reach is a feature that ships as "the button does nothing".
 *
 * The reopen pair used to be asserted here. Migration 0229 removed `acceptance_epoch`, and with it
 * everything a reopen preview had to report and everything its acknowledgement fenced — so what is
 * asserted is that neither route came back.
 */
test('L7-API17: neither reopen route survives the acceptance epoch it fenced', () => {
  const proto = ProjectsController.prototype as unknown as Record<string, object>;
  assert.equal('reopenPreview' in proto, false);
  assert.equal('reopen' in proto, false);
});

test('L7-API18: the attribution boundary is a GET on the task, not on a project', () => {
  const handler = (TasksController.prototype as unknown as Record<string, object>).attributionOf;
  // On the task, because the case it exists to make visible — work filed under NO project — has
  // an attribution boundary too, and no project page to hang it off.
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), ':id/attribution');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.GET);
});
