import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException, NotFoundException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { TasksController } from '../tasks/tasks.controller';
import { ProjectsController } from './projects.controller';
import { ProjectAttributionService } from './project-attribution.service';
import { ProjectsService } from './projects.service';

/**
 * Unit L7, the read face: what the queries hand the pure derivation, and what a reopen refuses.
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
const RUN = '019fcda0-d021-72a2-a914-2f4de38f4610';
const BLOCKER = '019fcda0-d021-72a2-a914-2f4de38f4611';
const HANDOFF = '019fcda0-d021-72a2-a914-2f4de38f4612';

const PROJECT_ROW = {
  id: PROJECT, title: 'Coordinator control loop', status: 'OPEN', acceptanceEpoch: 3n,
};

type Recorded = { criteria?: unknown; handoff?: unknown; blockers?: unknown };

function service(over: {
  task?: unknown;
  criteria?: unknown[];
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
              discoveredFromProject: {
                id: OTHER_PROJECT, title: 'Somewhere else', status: 'DONE', acceptanceEpoch: 9n,
              },
              sourceTask: { id: SOURCE_TASK, title: 'the task that noticed it' },
              sourceSession: { id: SOURCE_SESSION, title: null },
            }
          : over.task,
    },
    projectAcceptanceCriterion: {
      findMany: async (args: unknown) => {
        recorded.criteria = args;
        return over.criteria ?? [];
      },
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
  // The criteria are scoped by the project the task is filed under — a criterion in ANOTHER
  // project citing this task is not this task's acceptance, and rendering it beside the project's
  // own would be the surface asserting a cross-project claim it has no authority to make.
  assert.deepEqual((recorded.criteria as { where: unknown }).where, {
    evidenceTaskId: TASK, projectId: PROJECT,
  });
  assert.equal((recorded.handoff as { where: { ownerId: string } }).where.ownerId, OWNER);
  assert.deepEqual((recorded.blockers as { where: unknown }).where, {
    subjectType: 'TASK', subjectId: TASK, resolvedAt: null, project: { ownerId: OWNER },
  });
});

test('L7-API3: a task filed under no project asks the acceptance question of nobody', async () => {
  const recorded: Recorded = {};
  const view = await service({
    recorded,
    task: {
      id: TASK, projectId: null, project: null, triggerEvent: null,
      discoveredFromProject: null, sourceTask: null, sourceSession: null,
    },
  }).read(OWNER, TASK);
  assert.equal(recorded.criteria, undefined, 'no project, no acceptance query');
  assert.equal(view.owning, null);
  assert.equal(view.owningAbsentReason, 'FILED_UNDER_NO_PROJECT');
});

test('L7-API4: the epoch crosses the wire as a string, and the provenance is labelled evidence', async () => {
  const view = await service().read(OWNER, TASK);
  assert.equal(view.owning?.acceptanceEpoch, '3');
  assert.equal(view.discovery.project?.acceptanceEpoch, '9');
  assert.equal(view.discovery.authority, 'EVIDENCE_ONLY');
  assert.equal(view.discovery.triggerEvent, 'session.transcript');
  assert.equal(view.discovery.task?.title, 'the task that noticed it');
});

test('L7-API5: a criterion from the epoch before this one is readable and marked not current', async () => {
  const view = await service({
    criteria: [{
      ordinal: 2,
      criterionKey: 'abcd',
      criterionText: 'the loop never silently idles',
      verdict: 'PASS',
      run: { id: RUN, attempt: 4n, acceptanceEpoch: 2n, supersededAt: new Date() },
    }],
  }).read(OWNER, TASK);
  assert.equal(view.acceptance.length, 1);
  assert.equal(view.acceptance[0].verdict, 'PASS');
  assert.equal(view.acceptance[0].attempt, '4');
  assert.equal(view.acceptance[0].epoch, '2');
  assert.equal(view.acceptance[0].current, false);
  assert.equal(view.acceptance[0].staleReason, 'EPOCH_ADVANCED');
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
      toProject: { id: OTHER_PROJECT, title: 'Somewhere else', status: 'OPEN', acceptanceEpoch: 0n },
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

// ── The reopen door ───────────────────────────────────────────────────────────────────────────

/**
 * `ProjectsService.reopen` composed over a fake row. The refusals it can produce are the ones a
 * person hits, so they are asserted as CODES rather than as sentences — AC5: nothing about this is
 * decidable from prose or from a colour.
 */
async function reopenAgainst(
  project: { status: string; acceptanceEpoch: bigint; legacyAcceptedAt: Date | null } | null,
  acknowledged: string,
): Promise<{ code?: string; updated?: unknown }> {
  const updates: unknown[] = [];
  const service = Object.create(ProjectsService.prototype) as ProjectsService;
  Object.assign(service, {
    prisma: {
      project: { findFirst: async () => project },
      projectAcceptanceRun: { count: async () => 2 },
    },
  });
  (service as unknown as { update: unknown }).update = async (
    _owner: string, _id: string, dto: unknown,
  ) => {
    updates.push(dto);
    return { reopened: true };
  };
  try {
    await service.reopen(OWNER, PROJECT, { acknowledgedAcceptanceEpoch: acknowledged });
    return { updated: updates[0] };
  } catch (e) {
    if (e instanceof ConflictException) {
      return { code: (e.getResponse() as { code: string }).code };
    }
    throw e;
  }
}

test('L7-API11: reopening an OPEN project is refused before anything is written', async () => {
  const answer = await reopenAgainst(
    { status: 'OPEN', acceptanceEpoch: 3n, legacyAcceptedAt: null }, '3',
  );
  assert.equal(answer.code, 'PROJECT_NOT_SETTLED');
  assert.equal(answer.updated, undefined);
});

test('L7-API12: an acknowledgement the project has moved past is refused, not merged', async () => {
  const answer = await reopenAgainst(
    { status: 'DONE', acceptanceEpoch: 4n, legacyAcceptedAt: null }, '3',
  );
  assert.equal(answer.code, 'REOPEN_ACKNOWLEDGEMENT_STALE');
  assert.equal(answer.updated, undefined);
});

test('L7-API13: the acknowledged reopen goes through the ONE path that reopens', async () => {
  const answer = await reopenAgainst(
    { status: 'DONE', acceptanceEpoch: 4n, legacyAcceptedAt: null }, '4',
  );
  assert.equal(answer.code, undefined);
  // Not a second implementation of a reopen: it hands `update` the same status write a person
  // makes from the project page, with the acknowledgement carried through so the row lock re-checks
  // it against the value that is actually there when the write commits.
  assert.deepEqual(answer.updated, { status: 'OPEN', acknowledgedAcceptanceEpoch: '4' });
});

test('L7-API14: CANCELLED is settled too, so its reopen is confirmed the same way', async () => {
  assert.equal(
    (await reopenAgainst({ status: 'CANCELLED', acceptanceEpoch: 0n, legacyAcceptedAt: null }, '1'))
      .code,
    'REOPEN_ACKNOWLEDGEMENT_STALE',
  );
  assert.deepEqual(
    (await reopenAgainst({ status: 'CANCELLED', acceptanceEpoch: 0n, legacyAcceptedAt: null }, '0'))
      .updated,
    { status: 'OPEN', acknowledgedAcceptanceEpoch: '0' },
  );
});

test('L7-API15: the preview counts the attempts that are live, and hands out the acknowledgement', async () => {
  const service = Object.create(ProjectsService.prototype) as ProjectsService;
  let countArgs: unknown;
  Object.assign(service, {
    prisma: {
      project: {
        findFirst: async () => ({
          status: 'DONE', acceptanceEpoch: 7n, legacyAcceptedAt: new Date(),
        }),
      },
      projectAcceptanceRun: {
        count: async (args: unknown) => {
          countArgs = args;
          return 2;
        },
      },
    },
  });
  const impact = await service.reopenPreview(OWNER, PROJECT);
  assert.deepEqual((countArgs as { where: unknown }).where, {
    projectId: PROJECT, supersededAt: null,
  });
  assert.equal(impact.fromEpoch, '7');
  assert.equal(impact.toEpoch, '8');
  assert.equal(impact.retiringRuns, 2);
  assert.equal(impact.wasLegacy, true);
  assert.equal(impact.acknowledgement, '7', 'what the preview hands out is what the write takes');
});

test('L7-API16: a project nobody owns has no reopen to preview', async () => {
  const service = Object.create(ProjectsService.prototype) as ProjectsService;
  Object.assign(service, {
    prisma: {
      project: { findFirst: async () => null },
      projectAcceptanceRun: { count: async () => 0 },
    },
  });
  await assert.rejects(
    () => service.reopenPreview(OWNER, PROJECT),
    (e: unknown) => e instanceof NotFoundException,
  );
});

// ── The doors, as routes ──────────────────────────────────────────────────────────────────────

/**
 * The user-facing surface, by path and verb.
 *
 * Asserted from metadata rather than by booting the app because what can silently go wrong here is
 * spelling: a `GET :id/reopen` that answered the preview and a `POST :id/reopen` that performed it
 * are one letter apart from a `PATCH` that does neither, and a route nobody can reach is a feature
 * that ships as "the button does nothing".
 */
test('L7-API17: the reopen preview is a GET and the reopen itself is a POST', () => {
  const proto = ProjectsController.prototype as unknown as Record<string, object>;
  assert.equal(Reflect.getMetadata(PATH_METADATA, proto.reopenPreview), ':id/reopen');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, proto.reopenPreview), RequestMethod.GET);
  assert.equal(Reflect.getMetadata(PATH_METADATA, proto.reopen), ':id/reopen');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, proto.reopen), RequestMethod.POST);
});

test('L7-API18: the attribution boundary is a GET on the task, not on a project', () => {
  const handler = (TasksController.prototype as unknown as Record<string, object>).attributionOf;
  // On the task, because the case it exists to make visible — work filed under NO project — has
  // an attribution boundary too, and no project page to hang it off.
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), ':id/attribution');
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), RequestMethod.GET);
});
