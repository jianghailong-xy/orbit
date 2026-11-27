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
import { renderRawQuery } from '../test-support/prisma-transaction-double';
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
 * (project_update → PATCH /runner/projects/:id), and each write records who and when.
 *
 * Since revision 42 (§12.15 P-M3) the mark is still accepted, stored and returned, but nothing reads
 * it: landing follows from the commits a project's tasks delivered. Work that ran no branch and
 * reported nothing has nothing to land, marked or not; work that reported changes it cannot place
 * reads NO_BRANCH, marked or not.
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

  // The reason (0555): optional, sent with the mark, trimmed, replaced by every mark write.
  const reasoned = await patch({ nonCode: true, nonCodeReason: '  Vendor accounts only.  ' });
  assert.equal(reasoned.status, 200, JSON.stringify(reasoned.body));
  assert.equal(reasoned.body.nonCodeReason, 'Vendor accounts only.');
  assert.equal(row.nonCodeReason, 'Vendor accounts only.');
  const unreasoned = await patch({ nonCode: true });
  assert.equal(unreasoned.body.nonCodeReason, null, 'a mark written with no reason keeps none');
  // Alone it is refused: it is the reason for a write of the mark.
  assert.equal((await patch({ nonCodeReason: 'why' })).status, 400);
  assert.equal((await patch({ nonCode: true, nonCodeReason: 'x'.repeat(281) })).status, 400);
  assert.equal(row.nonCodeReason, null);
});

test('the coordinator sets and clears the mark through project_update’s runner door, recorded as COORDINATOR with its session', async () => {
  const row = projectRow();
  const service = new ProjectsService(writeDouble(row) as never, {} as never);
  // The runner door as it stands: the controller's own method, with the service it hands the
  // request to and nothing else of its wiring.
  const door = Object.create(RunnerProjectsController.prototype) as RunnerProjectsController;
  (door as unknown as { projects: ProjectsService }).projects = service;
  const runner = { id: randomUUID(), ownerId: OWNER_ID } as never;

  const set = await door.updateProject(runner, PROJECT_ID, COORDINATOR_SESSION_ID, {
    nonCode: true, nonCodeReason: 'All work is documents and vendor accounts; no repository.',
  }) as ProjectRow;
  assert.equal(set.nonCode, true);
  assert.equal(set.nonCodeReason, 'All work is documents and vendor accounts; no repository.');
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
 * isolation — no branch, no landing job, no receipt (the CBAI shape) — `changedFiles` as `reported`
 * says, and the mark as `marked` says. `written` collects what Record as done stores.
 */
function doneDouble(
  marked: { nonCode: boolean },
  written: Array<Record<string, unknown>>,
  reported: string[] | null = null,
) {
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
      sessions: [{ isolationStatus: 'shared', branch: null, changedFiles: reported, workspace: null }],
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
    // The project row lock answers its row; the deferred-landing read (FROM "task") finds no work
    // still moving, as Postgres would here.
    $queryRaw: async (...args: unknown[]) => (renderRawQuery(args).text.includes('FROM "task"')
      ? []
      : [{ status: 'OPEN', non_code: marked.nonCode }]),
  };
  return {
    ...client,
    $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(client),
  };
}

test('work that ran no branch and reported nothing has nothing to land, marked or not: the mark is not read', async () => {
  const marked = { nonCode: false };
  const written: Array<Record<string, unknown>> = [];
  const acceptance = new ProjectAcceptanceService(doneDouble(marked, written) as never);

  const unmarked = await acceptance.readProjectDoneCheck(OWNER_ID, PROJECT_ID);
  assert.equal(unmarked.nonCode, false);
  assert.equal(unmarked.criteria[0].satisfied, true);
  assert.equal(unmarked.criteria[0].landing, 'LANDED', 'no commit was delivered, so there is nothing to land');
  assert.equal(unmarked.criteria[0].reason, null);
  assert.deepEqual(unmarked.criteria[0].heldOffLanded, []);
  assert.deepEqual(unmarked.findings, []);

  marked.nonCode = true;
  const check = await acceptance.readProjectDoneCheck(OWNER_ID, PROJECT_ID);
  assert.equal(check.nonCode, false, 'the field is kept for clients and always reads false');
  assert.deepEqual(check.criteria, unmarked.criteria);
  assert.deepEqual(check.findings, []);
  assert.equal(check.stateDigest, unmarked.stateDigest, 'the mark is no part of what a request is made about');

  // The gaps the owner accepted are stored as given: the mark filters nothing out.
  const gap = {
    criterionKey: check.criteria[0].stated.key,
    title: 'ran without a branch',
    finding: { code: 'DONE_CRITERION_UNLANDED' } as never,
  };
  const done = await acceptance.recordProjectDone(OWNER_ID, PROJECT_ID, {
    criteriaDigest: check.criteriaDigest,
    acceptedGaps: [gap],
  });
  assert.equal(done.acceptedGaps.length, 1);
  assert.equal(written.at(-1)?.status, 'DONE');
});

test('branchless work that reported changes reads NO_BRANCH whether or not the project is marked', async () => {
  for (const nonCode of [false, true]) {
    const written: Array<Record<string, unknown>> = [];
    const acceptance = new ProjectAcceptanceService(doneDouble({ nonCode }, written, ['filing.pdf']) as never);
    const check = await acceptance.readProjectDoneCheck(OWNER_ID, PROJECT_ID);
    assert.equal(check.nonCode, false);
    assert.equal(check.criteria[0].reason, 'NO_BRANCH', `marked: ${nonCode}`);
    assert.deepEqual(
      check.findings.map((finding) => `${finding.code} ${finding.reason}`),
      ['DONE_CRITERION_UNLANDED NO_BRANCH'],
    );
    const recorded = await acceptance.recordProjectDone(OWNER_ID, PROJECT_ID, {
      criteriaDigest: check.criteriaDigest,
      acceptedGaps: [],
    });
    assert.deepEqual(
      recorded.acceptedGaps.map((gap) => (gap.finding as { code: string; reason: string }).code
        + ' ' + (gap.finding as { reason: string }).reason),
      ['DONE_CRITERION_UNLANDED NO_BRANCH'],
    );
  }
});

test('derivedDone reads landing alone: an unlanded criterion is withheld, and nonCode is always false', () => {
  const satisfaction = [
    { definitionId: 'met', satisfied: true },
    { definitionId: 'unmet', satisfied: false },
  ] as never;
  const landing = [
    { definitionId: 'met', landing: 'UNKNOWN', landingReason: 'NO_BRANCH' },
    { definitionId: 'unmet', landing: 'UNKNOWN', landingReason: 'NO_RECEIPT' },
  ] as never;

  const derived = derivedDoneFromLanes(satisfaction, landing, [], 'CONFIRMED');
  assert.equal(derived.nonCode, false);
  assert.deepEqual(derived.withheld, ['CRITERION_UNSATISFIED', 'CRITERION_UNLANDED']);
  assert.deepEqual(derived.criteria.map((c) => c.landingReason), ['NO_BRANCH', 'NO_RECEIPT']);
  assert.equal(derived.counts.byReason.NO_BRANCH, 1);

  const allMet = [{ definitionId: 'met', satisfied: true }] as never;
  const nothingToLand = [{ definitionId: 'met', landing: 'LANDED', landingReason: 'NOTHING_TO_LAND' }] as never;
  assert.equal(derivedDoneFromLanes(allMet, nothingToLand, [], 'CONFIRMED').done, true,
    'a criterion whose work delivered no commit is LANDED, and holds nothing back');
});
