import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastValueFrom, of } from 'rxjs';
import { uuidToBase62 } from '@orbit/shared';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { ConvergenceLedgerService, publicConvergenceKey } from './convergence-ledger.service';
import { ProjectsService } from './projects.service';

// `[K2]`'s read face (convergence §1/§4/§8 + the Base62 rule).
//
// Two things have to be true of it and neither is checked by the pg spec, which reads columns
// directly: the payload answers the question the endpoint exists for — why is this task still being
// attempted, or why is it not — and every id a caller could hand back reaches them in Base62.
//
// The second is the one that is easy to get half right. `PublicIdInterceptor` twins fields it
// recognises, but the two idempotency keys are STRINGS with a task's UUID buried in the middle of
// them, which the interceptor cannot see into. Those are publicized by the service, and this is
// what says so.

const OWNER = '019fe1dd-3f39-7610-8e5d-507e36a4ea9b';
const PROJECT = '019fcbf3-0fa8-7f83-9302-46b25389cb16';
const TASK = '019fcda0-d021-72a2-a914-2f4de38f469c';
const OTHER_TASK = '019fcda0-d021-72a2-a914-2f4de38f4700';
const DECISION = '019fcdad-acd0-73f1-b83e-34c901525105';
const SESSION = '019fcdae-c039-76c2-bb7b-1a7c550f8e26';

const TASK_ROW = {
  scopeRevision: 2,
  attemptGeneration: 3n,
  progressState: 'NEEDS_REPLAN',
  counters: {
    attemptsOnRevision: 3,
    attemptsWithoutProgress: 3,
    sameFingerprintRepeats: 3,
    decisionsWithoutProgress: 4,
    verificationRounds: 1,
    transientRetries: 0,
    scopeExpansionRequests: 0,
  },
  lastProgressAt: new Date('2026-08-22T09:00:00.000Z'),
  knownGoodSha: 'a'.repeat(40),
  title: 'T',
  description: null,
  acceptanceCriteria: 'AC',
  scopeHash: 'b'.repeat(64),
  automationPolicy: 'GUARDED_AUTO',
  thresholdOverrides: null,
  budgetOverrides: null,
  unboundedAuthorizedBy: null,
};

const REVISION_ROW = {
  revision: 2,
  scopeHash: 'b'.repeat(64),
  title: 'T',
  description: null,
  acceptanceCriteria: 'AC',
  authorizedByActor: 'USER',
  authorizedByPrincipal: 'u-1',
  automationPolicy: 'GUARDED_AUTO',
  reason: 'bigger than the task',
  supersedesRevision: 1,
  createdAt: new Date('2026-08-22T08:00:00.000Z'),
};

const LEDGER_ROW = {
  id: DECISION,
  seq: 7n,
  scopeRevision: 2,
  scopeHash: 'b'.repeat(64),
  attemptGeneration: 3n,
  idempotencyKey: `pc:v1:${TASK}:conv:2:session:${SESSION}:failed`,
  inputHash: 'c'.repeat(64),
  event: 'ATTEMPT_FAILED_IN_SCOPE',
  fromState: 'CONVERGING',
  toState: 'NEEDS_REPLAN',
  classification: 'IN_SCOPE_DEFECT',
  decision: 'FREEZE_AND_REQUEST_REPLAN',
  action: null,
  actionIdempotencyKey: null,
  failureFingerprint: 'd'.repeat(64),
  progressVector: { scopeHash: 'b'.repeat(64), acceptanceClosed: 1, acceptanceTotal: 4 },
  progressVectorDigest: 'e'.repeat(64),
  progressed: false,
  counters: TASK_ROW.counters,
  nonConvergenceReason: 'SAME_FAILURE_REPEATED',
  knownGoodSha: 'a'.repeat(40),
  requiredAction: 'Change the hypothesis.',
  owner: 'USER',
  nextCheckAt: null,
  decidedBy: 'ORCHESTRATOR',
  sessionId: SESSION,
  projectDecisionId: null,
  createdAt: new Date('2026-08-22T09:30:00.000Z'),
};

/** A prisma whose three `$queryRaw` calls answer in the order `describe` makes them. */
function ledgerService(rows: unknown[][] = [[TASK_ROW], [], [REVISION_ROW], [LEDGER_ROW]]) {
  let call = 0;
  const prisma = {
    $queryRaw: async () => rows[call++] ?? [],
  };
  return new ConvergenceLedgerService(prisma as never);
}

function through<T>(body: T): Promise<T> {
  class Controller {}
  return lastValueFrom(
    new PublicIdInterceptor().intercept(
      { getClass: () => Controller } as never,
      { handle: () => of(body) } as never,
    ),
  ) as Promise<T>;
}

test('the payload answers why this task stopped, with the limit that applied', async () => {
  const described = await ledgerService().describe(OWNER, TASK);
  assert.equal(described.progressState, 'NEEDS_REPLAN');
  assert.equal(described.scopeRevision, 2);
  assert.equal(described.attemptGeneration, 3);
  // The RESOLVED threshold, not the project's override column. A caller asking why a task stopped
  // needs the limit that applied, and a null that means "the default did" is not an answer.
  assert.equal(described.thresholds.maxSameFingerprintRepeats, 2);
  assert.equal(described.attemptBudget.maxTurns, 60);
  assert.equal(described.counters.sameFingerprintRepeats, 3);
  const [entry] = described.ledger;
  assert.equal(entry.nonConvergenceReason, 'SAME_FAILURE_REPEATED');
  assert.equal(entry.requiredAction, 'Change the hypothesis.');
  assert.equal(entry.owner, 'USER');
  assert.equal(entry.nextCheckAt, null, 'a wait for a person carries no clock');
  // BigInt columns cross the wire as decimal strings, as every other one here does.
  assert.equal(entry.seq, '7');
  assert.equal(entry.attemptGeneration, '3');
});

test('the superseded revisions are served, because they ARE the audit', async () => {
  const described = await ledgerService([
    [TASK_ROW], [],
    [{ ...REVISION_ROW, revision: 1, authorizedByActor: null, authorizedByPrincipal: null, supersedesRevision: null, acceptanceCriteria: 'AC' }, REVISION_ROW],
    [LEDGER_ROW],
  ]).describe(OWNER, TASK);
  assert.equal(described.revisions.length, 2);
  assert.equal(described.revisions[0].authorizedByActor, null, 'revision 1 is "as found"');
  assert.equal(described.revisions[1].authorizedByActor, 'USER');
  assert.equal(described.managed, true);
});

test('every id leaves in Base62, including the ones buried inside a key', async () => {
  const withAction = {
    ...LEDGER_ROW,
    action: 'DISPATCH_ATTEMPT',
    actionIdempotencyKey: `pc:v1:${TASK}:conv-act:2:3:DISPATCH_ATTEMPT`,
  };
  const payload = await through(
    await ledgerService([[TASK_ROW], [], [REVISION_ROW], [withAction]]).describe(OWNER, TASK),
  ) as unknown as Record<string, unknown>;

  assert.equal(payload.taskId, uuidToBase62(TASK));
  const entry = (payload.ledger as Array<Record<string, unknown>>)[0];
  assert.equal(entry.id, uuidToBase62(DECISION));
  assert.equal(entry.sessionId, uuidToBase62(SESSION));
  assert.equal(entry.idempotencyKey, `pc:v1:${uuidToBase62(TASK)}:conv:2:session:${uuidToBase62(SESSION)}:failed`);
  assert.equal(entry.actionIdempotencyKey, `pc:v1:${uuidToBase62(TASK)}:conv-act:2:3:DISPATCH_ATTEMPT`);
  assert.doesNotMatch(
    JSON.stringify(payload),
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
  );
});

test('a key whose parts are natural names is left alone, not mangled', async () => {
  // Publicizing is a best-effort translation of ids and must never damage something that was never
  // one — the same rule `publicDedupeKey` follows for a blocker whose subject is a provider slug.
  const key = 'pc:v1:not-a-uuid:conv:2:verdict:claude:3';
  assert.equal(publicConvergenceKey(key), key);
});

test('an unmanaged task reads as unmanaged rather than as an error', async () => {
  // Every task filed before `[K2]` is one of these, and "this endpoint has nothing for it" has to
  // be distinguishable from "this server does not report convergence".
  const described = await ledgerService([[{ ...TASK_ROW, scopeHash: null, scopeRevision: 1 }], [], [], []])
    .describe(OWNER, TASK);
  assert.equal(described.managed, false);
  assert.equal(described.revisions.length, 0);
  assert.equal(described.ledger.length, 0);
  // The digest is still well defined — it is a function of the task's own text.
  assert.match(described.scopeHash, /^[0-9a-f]{64}$/);
});

test('the route refuses a task that is not this project\'s, with the same answer as "no such task"', async () => {
  // One query, and `not found` for both cases: an endpoint that distinguished them would confirm
  // ids across a tenancy boundary.
  const asked: unknown[] = [];
  const projects = new ProjectsService({
    project: { findFirst: async () => ({ id: PROJECT }) },
    task: {
      findFirst: async (args: unknown) => {
        asked.push(args);
        return null;
      },
    },
  } as never, {} as never);

  await assert.rejects(
    () => projects.assertTaskInProject(OWNER, PROJECT, OTHER_TASK),
    /task not found/,
  );
  assert.deepEqual(asked, [{
    where: { id: OTHER_TASK, ownerId: OWNER, projectId: PROJECT },
    select: { id: true },
  }]);
});
