import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { ForbiddenException, Module, ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { RunnerProjectsController } from '../runner-api/runner-projects.controller';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { derivedDoneFromLanes } from './project-done-derived';
import { ProjectFuseService } from './project-fuse.service';
import { ProjectHandoffService } from './project-handoff.service';
import { ProjectOpenItemService } from './project-open-item.service';
import { ProjectsController } from './projects.controller';
import { NON_CODE_COORDINATOR_ONLY, ProjectsService } from './projects.service';
import { SessionAttemptService } from './session-attempt.service';
import { TaskCheckpointService } from './task-checkpoint.service';

/**
 * A project is non-code only by an explicit mark (owner decision 2026-11-11), set or cleared by the
 * account owner (PATCH /projects/:id) or by the conversation the project is coordinated from
 * (project_update → PATCH /runner/projects/:id), and each write records who and when. A marked
 * project reads no landing: its done check finds nothing unlanded, and recording it done stores no
 * landing gaps. Clearing the mark brings them back — as NO_BRANCH for work that ran without one.
 *
 * The services are the real ones; only the database underneath them is a double, holding one
 * project row the writes land on and the reads read back.
 */

const OWNER_ID = randomUUID();
const PROJECT_ID = randomUUID();
const COORDINATOR_SESSION_ID = randomUUID();
const OTHER_SESSION_ID = randomUUID();
const DEFINITION_ID = randomUUID();
const TASK_ID = randomUUID();

interface ProjectRow {
  id: string;
  ownerId: string;
  title: string;
  status: string;
  coordinatorSessionId: string | null;
  nonCode: boolean;
  nonCodeSetBy: string | null;
  nonCodeSetBySessionId: string | null;
  nonCodeSetAt: Date | null;
  [key: string]: unknown;
}

function projectRow(): ProjectRow {
  return {
    id: PROJECT_ID,
    ownerId: OWNER_ID,
    title: 'Get the ICP filing approved',
    status: 'OPEN',
    coordinatorSessionId: COORDINATOR_SESSION_ID,
    coordinatorEnabled: true,
    nonCode: false,
    nonCodeSetBy: null,
    nonCodeSetBySessionId: null,
    nonCodeSetAt: null,
  };
}

/** The project document a write returns: the row, with the relations `withCoordination` folds. */
const documentOf = (row: ProjectRow) => ({
  ...row,
  acceptanceCriterionDefinitions: [],
  members: [],
  runtime: { coordinatorGeneration: 0 },
});

/** The database for the write path: one project row, which `update` writes and the reads return. */
function writeDouble(row: ProjectRow) {
  const tx = {
    $queryRaw: async () => [{
      config_revision: 0n,
      status: row.status,
      coordinator_session_id: row.coordinatorSessionId,
      coordinator_enabled: true,
      started_at: null,
      paused_at: null,
      paused_reason: null,
    }],
    project: {
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(row, data);
        return documentOf(row);
      },
    },
    session: { updateMany: async () => ({ count: 0 }) },
  };
  return {
    project: { findFirst: async () => ({ ...row }) },
    $transaction: async (run: (client: unknown) => Promise<unknown>) => run(tx),
  };
}

const refuse = (name: string) => () => {
  throw new Error(`${name} must not be reached by this spec`);
};

test('the owner sets and clears the mark through PATCH /projects/:id, and it reads back with who and when', async (t) => {
  const row = projectRow();
  @Module({
    controllers: [ProjectsController],
    providers: [
      { provide: ProjectsService, useFactory: () => new ProjectsService(writeDouble(row) as never, {} as never) },
      { provide: ProjectAcceptanceService, useValue: { recordMergeEvidence: refuse('acceptance') } },
      { provide: ProjectHandoffService, useValue: { listForProject: refuse('handoffs') } },
      { provide: SessionAttemptService, useValue: { describe: refuse('attempts') } },
      { provide: TaskCheckpointService, useValue: { record: refuse('checkpoints') } },
      { provide: ProjectOpenItemService, useValue: { list: refuse('open items') } },
      { provide: ProjectFuseService, useValue: { resume: refuse('the fuse') } },
      JwtAuthGuard,
      Reflector,
      { provide: JwtService, useValue: { verifyAsync: async () => ({ sub: OWNER_ID }) } },
      { provide: PrismaService, useValue: {} },
    ],
  })
  class OwnerDoor {}

  const app = await NestFactory.create(OwnerDoor, { logger: false, abortOnError: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalInterceptors(new PublicIdInterceptor());
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  t.after(() => app.close());

  const patch = async (body: unknown) => {
    const response = await fetch(`${base}/api/projects/${PROJECT_ID}`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer the-owner', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  const before = Date.now();
  const set = await patch({ nonCode: true });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.nonCode, true);
  assert.equal(set.body.nonCodeSetBy, 'OWNER');
  assert.equal(set.body.nonCodeSetBySessionId, null, 'the owner writes it from no conversation');
  assert.ok(Date.parse(set.body.nonCodeSetAt as string) >= before, 'and says when');
  assert.equal(row.nonCode, true, 'the row holds it, not only the answer');

  const cleared = await patch({ nonCode: false });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.nonCode, false);
  assert.equal(cleared.body.nonCodeSetBy, 'OWNER', 'clearing is recorded the same way');
  assert.equal(row.nonCode, false);

  // A request that does not name the mark leaves it, and who wrote it, alone.
  const stamp = row.nonCodeSetAt;
  assert.equal((await patch({ title: 'Renamed' })).status, 200);
  assert.equal(row.nonCodeSetAt, stamp);

  // Only a boolean.
  assert.equal((await patch({ nonCode: 'yes' })).status, 400);
  assert.equal((await patch({ nonCode: null })).status, 400);
});

test('the coordinator sets and clears the mark through project_update’s runner door, recorded as COORDINATOR with its session', async () => {
  const row = projectRow();
  const service = new ProjectsService(writeDouble(row) as never, {} as never);
  // The runner door as it stands: the controller's own method, with the service it hands the
  // request to and nothing else of its wiring.
  const door = Object.create(RunnerProjectsController.prototype) as RunnerProjectsController;
  (door as unknown as { projects: ProjectsService }).projects = service;
  const runner = { id: randomUUID(), ownerId: OWNER_ID } as never;

  const set = await door.updateProject(runner, PROJECT_ID, COORDINATOR_SESSION_ID, { nonCode: true }) as ProjectRow;
  assert.equal(set.nonCode, true);
  assert.equal(set.nonCodeSetBy, 'COORDINATOR');
  assert.equal(set.nonCodeSetBySessionId, COORDINATOR_SESSION_ID);
  assert.ok(set.nonCodeSetAt instanceof Date);

  const cleared = await door.updateProject(runner, PROJECT_ID, COORDINATOR_SESSION_ID, { nonCode: false }) as ProjectRow;
  assert.equal(cleared.nonCode, false);
  assert.equal(cleared.nonCodeSetBy, 'COORDINATOR');
  assert.equal(cleared.nonCodeSetBySessionId, COORDINATOR_SESSION_ID);

  // Any other conversation is refused whole, and nothing is written.
  const stamp = row.nonCodeSetAt;
  await assert.rejects(
    door.updateProject(runner, PROJECT_ID, OTHER_SESSION_ID, { nonCode: true }),
    (e: unknown) => e instanceof ForbiddenException
      && (e.getResponse() as { code?: string }).code === NON_CODE_COORDINATOR_ONLY,
  );
  assert.equal(row.nonCode, false);
  assert.equal(row.nonCodeSetAt, stamp);

  // The headless runner path carries no session: it is the owner operating the machine.
  const headless = await door.updateProject(runner, PROJECT_ID, undefined, { nonCode: true }) as ProjectRow;
  assert.equal(headless.nonCodeSetBy, 'OWNER');
  assert.equal(headless.nonCodeSetBySessionId, null);
});

/**
 * The done side's database: one met criterion served by one DONE task whose work ran in shared
 * isolation — no branch, no landing job, no receipt (the CBAI shape) — and the mark as `marked`
 * says. `written` collects what Record as done stores.
 */
function doneDouble(marked: { nonCode: boolean }, written: Array<Record<string, unknown>>) {
  const definition = {
    id: DEFINITION_ID,
    ordinal: 1,
    text: 'The ICP filing is approved',
    verificationMethod: 'The approval letter is attached',
    completionCriterionOverrideReason: null,
    revision: 1,
    contentHash: 'a'.repeat(64),
    servingTasks: [{
      id: TASK_ID,
      title: 'File for ICP',
      status: 'DONE',
      criterionDefinitionId: DEFINITION_ID,
      criterionRevision: 1,
      completionCriterion: 'EXECUTABLE',
      verifiesTaskId: null,
      verdict: null,
      verifiedBy: [],
      verifies: null,
      completionEvidence: [],
      codeless: false,
      mergeReceipts: [],
      sessions: [{ isolationStatus: 'shared', branch: null, workspace: null }],
      project: { codebases: [] },
    }],
  };
  const client = {
    project: {
      findFirst: async () => ({ id: PROJECT_ID, ownerId: OWNER_ID, nonCode: marked.nonCode }),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        written.push(data);
        return {};
      },
    },
    projectAcceptanceCriterionDefinition: { findMany: async () => [definition] },
    projectIntegrationJob: { findMany: async () => [] },
    projectCodebase: { findFirst: async () => null },
    task: {
      findMany: async () => [{
        id: TASK_ID,
        title: 'File for ICP',
        status: 'DONE',
        criterionDefinitionId: DEFINITION_ID,
        progress: { lifecycleEpoch: 0 },
      }],
    },
    session: { findMany: async () => [] },
    projectOpenItem: { findMany: async () => [], updateMany: async () => ({ count: 0 }) },
    $queryRaw: async () => [{ status: 'OPEN', non_code: marked.nonCode }],
  };
  return {
    ...client,
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(client),
  };
}

test('a marked project’s done check finds nothing unlanded and Record as done stores no landing gap; clearing the mark brings NO_BRANCH back', async () => {
  const marked = { nonCode: true };
  const written: Array<Record<string, unknown>> = [];
  const acceptance = new ProjectAcceptanceService(doneDouble(marked, written) as never);

  // Marked: the criterion is met, carries no landing reason, and nothing is found unlanded.
  const check = await acceptance.readProjectDoneCheck(OWNER_ID, PROJECT_ID);
  assert.equal(check.nonCode, true);
  assert.equal(check.criteria[0].satisfied, true, 'whether the criterion is met is unchanged');
  assert.equal(check.criteria[0].reason, null);
  assert.deepEqual(check.criteria[0].heldOffLanded, []);
  assert.deepEqual(check.findings.filter((finding) => finding.code === 'DONE_CRITERION_UNLANDED'), []);
  assert.deepEqual(check.findings, [], 'and nothing else stands in the way of this one');

  const done = await acceptance.recordProjectDone(OWNER_ID, PROJECT_ID, {
    criteriaDigest: check.criteriaDigest,
    // A card read before the mark was set may still send the landing gap it showed then.
    acceptedGaps: [{
      criterionKey: check.criteria[0].stated.key,
      title: 'ran without a branch',
      finding: { code: 'DONE_CRITERION_UNLANDED' } as never,
    }],
  });
  assert.deepEqual(done.acceptedGaps, [], 'a marked project stores no landing gap');
  assert.deepEqual(written.at(-1)?.acceptedGaps, []);
  assert.equal(written.at(-1)?.status, 'DONE');

  // Cleared: the same work is reported unlanded again — NO_BRANCH, the honest reason for it.
  marked.nonCode = false;
  const unmarked = await acceptance.readProjectDoneCheck(OWNER_ID, PROJECT_ID);
  assert.equal(unmarked.nonCode, false);
  assert.equal(unmarked.criteria[0].reason, 'NO_BRANCH');
  assert.deepEqual(
    unmarked.findings.map((finding) => `${finding.code} ${finding.reason}`),
    ['DONE_CRITERION_UNLANDED NO_BRANCH'],
  );
  assert.notEqual(unmarked.stateDigest, check.stateDigest, 'the mark is part of what a request was made about');

  const recorded = await acceptance.recordProjectDone(OWNER_ID, PROJECT_ID, {
    criteriaDigest: unmarked.criteriaDigest,
    acceptedGaps: [],
  });
  assert.deepEqual(
    recorded.acceptedGaps.map((gap) => (gap.finding as { code: string; reason: string }).code
      + ' ' + (gap.finding as { reason: string }).reason),
    ['DONE_CRITERION_UNLANDED NO_BRANCH'],
    'an unmarked project records its landing gap as before',
  );
});

test('derivedDone: a marked project is not withheld for landing, carries no landing reason and no landing tally', () => {
  const satisfaction = [
    { definitionId: 'met', satisfied: true },
    { definitionId: 'unmet', satisfied: false },
  ] as never;
  const landing = [
    { definitionId: 'met', landing: 'UNKNOWN', landingReason: 'NO_BRANCH' },
    { definitionId: 'unmet', landing: 'UNKNOWN', landingReason: 'NO_RECEIPT' },
  ] as never;

  const unmarked = derivedDoneFromLanes(satisfaction, landing, [], 'CONFIRMED');
  assert.equal(unmarked.nonCode, false);
  assert.deepEqual(unmarked.withheld, ['CRITERION_UNSATISFIED', 'CRITERION_UNLANDED']);
  assert.deepEqual(unmarked.criteria.map((c) => c.landingReason), ['NO_BRANCH', 'NO_RECEIPT']);
  assert.equal(unmarked.counts.byReason.NO_BRANCH, 1);

  const marked = derivedDoneFromLanes(satisfaction, landing, [], 'CONFIRMED', true);
  assert.equal(marked.nonCode, true);
  assert.deepEqual(marked.withheld, ['CRITERION_UNSATISFIED'], 'only what is not met holds it');
  assert.deepEqual(marked.criteria.map((c) => c.withheld), [[], ['CRITERION_UNSATISFIED']]);
  assert.deepEqual(marked.criteria.map((c) => c.landingReason), [null, null]);
  assert.deepEqual(marked.criteria.map((c) => c.satisfied), [true, false], 'satisfaction is unchanged');
  assert.equal(marked.counts.criteria, 2);
  assert.equal(marked.counts.met, 1);
  assert.equal(marked.counts.landed, 0);
  assert.equal(marked.counts.onMain, 0);
  assert.ok(Object.values(marked.counts.byReason).every((n) => n === 0));

  // With every criterion met, the marked project derives DONE where the unmarked one would not.
  const allMet = [{ definitionId: 'met', satisfied: true }] as never;
  const oneLanding = [{ definitionId: 'met', landing: 'UNKNOWN', landingReason: 'NO_BRANCH' }] as never;
  assert.equal(derivedDoneFromLanes(allMet, oneLanding, [], 'CONFIRMED', true).done, true);
  assert.equal(derivedDoneFromLanes(allMet, oneLanding, [], 'CONFIRMED').done, false);
});
