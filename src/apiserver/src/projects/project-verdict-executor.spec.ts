/**
 * That §13.2 has an executor at all, and that its key is the one §7.3 declares.
 *
 * This is a wiring spec, and it is the cheap half of the regression. The expensive half —
 * `project-verdict-reconcile.pg.spec` — proves a FAIL written through the task door reverts its
 * subject on a real database. What that one cannot do is fail FAST, and the defect it was written
 * for was never a wrong effect: `ProjectVerificationVerdictService` was correct, covered, exported
 * from `ProjectsModule`, and called by nothing but its own tests. Nobody registered it, so nobody
 * ran it, and the surface said "no failures" for every verdict this deployment ever concluded.
 *
 * So the fact under test is the registration, stated without a database: the service installs
 * itself on the ledger at module init, and the key it installs carries the verdict REVISION.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectReconcileService, ProjectVerdictExecutor } from './project-reconcile.service';
import { ProjectVerificationVerdictService } from './project-verification-verdict.service';
import { PlannedVerificationVerdict, verificationVerdictActionKey } from './task-verification-verdict';

/** The ledger, with nothing behind it: registration is a field write, not a query. */
function reconciler(): ProjectReconcileService {
  return new ProjectReconcileService(
    {} as unknown as PrismaService,
    { registerHandler: () => () => {} } as never,
  );
}

function service(loop: ProjectReconcileService): ProjectVerificationVerdictService {
  return new ProjectVerificationVerdictService({} as unknown as PrismaService, loop);
}

/** Any other executor, to prove the slot is taken. */
const otherExecutor: ProjectVerdictExecutor = {
  idempotencyKey: () => 'pc:v1:x:verdict:y:1',
  actionDetail: () => ({}),
  applyVerdictInTransaction: async () => undefined,
};

function planned(overrides: Partial<PlannedVerificationVerdict> = {}): PlannedVerificationVerdict {
  const verifierTaskId = uuidToBase62(randomUUID());
  const subjectTaskId = uuidToBase62(randomUUID());
  return {
    verifierTaskId,
    subjectTaskId,
    verdict: 'FAIL',
    verdictRevision: '1',
    consequences: {
      revertSubject: true,
      fileDefect: true,
      blockDownstream: true,
      raiseCondition: true,
      resolveConditions: false,
      opensCoordinatorTurn: true,
    },
    evidence: {
      v: 1,
      verifierTaskId,
      subjectTaskId,
      verdict: 'FAIL',
      verdictRevision: '1',
      verifierStatus: 'DONE',
      subjectStatus: 'DONE',
      session: null,
    },
    ...overrides,
  };
}

test('the verdict unit installs itself on the reconcile ledger at module init', () => {
  const loop = reconciler();
  // Before: the slot is free, which is exactly the state production shipped in.
  const release = loop.registerVerdictExecutor(otherExecutor);
  release();

  const verdicts = service(loop);
  verdicts.onModuleInit();
  assert.throws(
    () => loop.registerVerdictExecutor(otherExecutor),
    /verdict executor is already registered/,
    'the loop now holds this service and refuses a second one',
  );

  verdicts.onModuleDestroy();
  loop.registerVerdictExecutor(otherExecutor)();
});

test('registering the same executor twice is idempotent, a different one is refused', () => {
  const loop = reconciler();
  const verdicts = service(loop);
  const release = loop.registerVerdictExecutor(verdicts);
  loop.registerVerdictExecutor(verdicts);
  assert.throws(() => loop.registerVerdictExecutor(otherExecutor));
  release();
  loop.registerVerdictExecutor(otherExecutor)();
});

test('the action key is the one §7.3 declares, and it carries the revision (V7)', () => {
  const verdicts = service(reconciler());
  const projectId = randomUUID();
  const verifierId = randomUUID();

  assert.equal(
    verdicts.idempotencyKey(projectId, verifierId, '1'),
    verificationVerdictActionKey(projectId, verifierId, '1'),
  );
  assert.equal(
    verdicts.idempotencyKey(projectId, verifierId, '1'),
    `pc:v1:${projectId}:verdict:${verifierId}:1`,
  );
  // The whole of V4: the same check failing twice is two conclusions, not one replayed.
  assert.notEqual(
    verdicts.idempotencyKey(projectId, verifierId, '1'),
    verdicts.idempotencyKey(projectId, verifierId, '3'),
  );
});

test('the ledger detail is structured, Base62, and quotes nothing from the run', () => {
  const verdicts = service(reconciler());
  const one = planned();
  const detail = verdicts.actionDetail(one) as Record<string, unknown>;

  assert.equal(detail.v, 1);
  assert.equal(detail.verdict, 'FAIL');
  assert.equal(detail.verdictRevision, '1');
  assert.equal(detail.verifierTaskId, one.verifierTaskId);
  assert.equal(detail.subjectTaskId, one.subjectTaskId);
  assert.deepEqual(detail.consequences, one.consequences);
  // `project_action.detail` is read back over the audit API, and it is prose-free JSON that the
  // response interceptor never rewrites — so a raw UUID in here is one no caller can use.
  assert.doesNotMatch(
    JSON.stringify(detail),
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
  );
  // A verdict with no run is a fact, not an absence to be papered over.
  assert.equal((detail.evidence as Record<string, unknown>).session, null);
});
