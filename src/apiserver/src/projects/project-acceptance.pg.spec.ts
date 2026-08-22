import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ExecutionContext } from '@nestjs/common';
import { ProjectStatus, TaskStatus, TaskVerdict } from '@prisma/client';
import { of, firstValueFrom } from 'rxjs';
import { PublicIdInterceptor } from '../common/public-id.interceptor';
import { ProjectsController } from './projects.controller';
import {
  E2eServices,
  connectIsolatedPg,
  emptyWorld,
  rawUuidPaths,
  servicesOn,
  task,
  world,
} from './project-e2e-harness';
import { AcceptanceRefusal } from './project-acceptance.service';

/**
 * Unit 25A: native project acceptance and the DONE hard gate, on real PostgreSQL.
 *
 * The whole point of this mechanism is that it cannot be argued with, so nearly everything here is
 * a property of the DATABASE rather than of a service: the trigger that reopens a settled project
 * when a fact underneath it moves, the constraint that refuses a DONE with nothing behind it, the
 * guard that refuses to rewrite a conclusion. A unit test can show that the code intends those.
 * These show what still holds when the next writer forgets — including a writer that reaches the
 * tables through raw SQL, which is how every one of the earlier lessons in this repo arrived.
 *
 * Driven through the doors, per unit 22's rule: `ProjectsService.update` is how a project is
 * settled, `ProjectAcceptanceService` is how an acceptance is run, and no scenario reaches past
 * either into a table it is asserting about.
 */

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const CRITERIA = [
  'every suite is green on a disposable database',
  'the branch content is on the target branch',
  'no blocker is open',
].join('\n');

const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0127_project_acceptance_run/migration.sql'),
  'utf8',
);

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

async function servePublicIds(payload: unknown): Promise<unknown> {
  const context = {
    getClass: () => ProjectsController,
    getHandler: () => ProjectsController.prototype.acceptanceOverview,
  } as unknown as ExecutionContext;
  return firstValueFrom(
    new PublicIdInterceptor().intercept(context, { handle: () => of(payload) }),
  );
}

/** Run an acceptance to a PASS: open it, then answer every criterion. The shape a coordinator turn
 *  produces, and the only shape that can reach PASS. */
async function passing(services: E2eServices, ownerId: string, projectId: string) {
  const run = await services.acceptance.openRun(ownerId, projectId, { decidedBy: 'COORDINATOR_AGENT' });
  return services.acceptance.finalizeRun(
    ownerId, projectId, run.id,
    run.criteria.map((c) => ({
      ordinal: c.ordinal,
      verdict: 'PASS' as const,
      summary: `checked ${c.criterionText}`,
      evidence: { command: 'npm test', exitCode: 0, sha: 'deadbeef' },
    })),
  );
}

/**
 * The refusal a DONE produced, or `null` if it was allowed.
 *
 * Served through the id mapping first, because a refusal body leaves by the same door a success
 * body does — `PublicIdExceptionFilter` runs exactly this over what a handler throws — and then
 * asserted to carry no raw UUID ANYWHERE, prose included. A refusal that names the acceptance run
 * in the way is only actionable if the name is one the caller can hand back, and this is the
 * assertion that covers the throw sites a mapper cannot reach: the ones that write an id into a
 * sentence.
 */
async function refusalOf(fn: () => Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    if (!(error instanceof AcceptanceRefusal)) throw error;
    const body = (await servePublicIds(error.getResponse())) as { code: string; message: string };
    const leaked = rawUuidPaths(body, '$.refusal');
    assert.deepEqual(leaked, [], `a refusal must name rows in Base62 — leaked ${leaked.join(', ')}`);
    return { code: body.code, message: body.message };
  }
}

test('unit 25A: project acceptance and the DONE hard gate', { skip, timeout: 900_000 }, async (t) => {
  const identity = await connectIsolatedPg(URL);
  const applied = await identity.query<{ count: string }>(`
    SELECT count(*)::text AS count FROM "_prisma_migrations"
     WHERE "migration_name" = '0127_project_acceptance_run' AND "finished_at" IS NOT NULL`);
  assert.equal(applied.rows[0].count, '1', 'migration 0127 has not been applied to this database');

  const services = servicesOn(URL!);
  t.after(async () => {
    await services.dispose();
    await identity.end();
  });

  await t.test('a DONE with no acceptance behind it is refused, and the project stays OPEN', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'no-acceptance', { acceptanceCriteria: CRITERIA });

    const refusal = await refusalOf(() =>
      services.projects.update(target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never));
    assert.equal(refusal?.code, 'ACCEPTANCE_MISSING');

    const after = await services.db.project.findUniqueOrThrow({ where: { id: target.projectId } });
    assert.equal(after.status, ProjectStatus.OPEN);
    assert.equal(after.acceptedRunId, null);

    // A refused DONE is a thing somebody has to be able to look up: "I pressed it and nothing
    // happened" is the report, and the refusal rolled back with the transaction that raised it.
    const audit = await services.db.projectAcceptanceAudit.findMany({
      where: { projectId: target.projectId, kind: 'done_refused' },
    });
    assert.equal(audit.length, 1);
    assert.equal(audit[0].reason, 'ACCEPTANCE_MISSING');
  });

  await t.test('an unconcluded, an INCONCLUSIVE and a FAIL acceptance are all refused', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'not-passing', { acceptanceCriteria: CRITERIA });

    const open = await services.acceptance.openRun(target.ownerId, target.projectId, { decidedBy: 'USER' });
    assert.equal(open.criteria.length, 3, 'the checklist is one row per stated criterion');
    assert.deepEqual(open.criteria.map((c) => c.verdict), [null, null, null]);
    assert.equal(
      (await refusalOf(() => services.projects.update(
        target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never)))?.code,
      'ACCEPTANCE_MISSING',
      'an attempt that has not concluded is not evidence',
    );

    // Every criterion must be answered — a PASS over an unfinished checklist is exactly the claim
    // this mechanism exists to refuse.
    await assert.rejects(
      () => services.acceptance.finalizeRun(target.ownerId, target.projectId, open.id, [
        { ordinal: 1, verdict: 'PASS' },
      ]),
      /criteria 2, 3 have no conclusion/,
    );

    const inconclusive = await services.acceptance.finalizeRun(
      target.ownerId, target.projectId, open.id,
      [
        { ordinal: 1, verdict: 'PASS' },
        { ordinal: 2, verdict: 'INCONCLUSIVE', summary: 'could not reach the remote' },
        { ordinal: 3, verdict: 'PASS' },
      ],
    );
    // The run's verdict is DERIVED from the criteria and never supplied — that is the difference
    // between this and writing "all green" in a comment.
    assert.equal(inconclusive.verdict, 'INCONCLUSIVE');
    assert.equal(
      (await refusalOf(() => services.projects.update(
        target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never)))?.code,
      'ACCEPTANCE_MISSING',
    );

    const second = await services.acceptance.openRun(target.ownerId, target.projectId, { decidedBy: 'USER' });
    const failed = await services.acceptance.finalizeRun(
      target.ownerId, target.projectId, second.id,
      second.criteria.map((c) => ({
        ordinal: c.ordinal,
        verdict: c.ordinal === 2 ? ('FAIL' as const) : ('PASS' as const),
      })),
    );
    assert.equal(failed.verdict, 'FAIL');
    assert.equal(
      (await refusalOf(() => services.projects.update(
        target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never)))?.code,
      'ACCEPTANCE_MISSING',
    );
    assert.equal(
      (await services.db.project.findUniqueOrThrow({ where: { id: target.projectId } })).status,
      ProjectStatus.OPEN,
    );
  });

  await t.test('an open blocker or an unresolved verification failure refuses DONE', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'blocked', { acceptanceCriteria: CRITERIA });
    const subject = await task(services.db, target, 'the work', { status: TaskStatus.DONE });
    const verifier = await task(services.db, target, 'the check', {
      // `[K5]`'s 0141: a check cannot REACH DONE without saying what it found, so the conclusion is
      // seeded with the row. FAIL, because the failure row below is this check's — a fixture that
      // said PASS here would describe a check disagreeing with its own recorded verdict.
      status: TaskStatus.DONE, verifiesTaskId: subject, verdict: 'FAIL',
    });
    await passing(services, target.ownerId, target.projectId);

    await services.db.taskVerificationFailure.create({
      data: {
        projectId: target.projectId,
        verifierTaskId: verifier,
        subjectTaskId: subject,
        verdict: TaskVerdict.FAIL,
        verdictRevision: 1n,
        blocksDownstream: true,
        evidence: {},
      },
    });
    const refusal = await refusalOf(() =>
      services.projects.update(target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never));
    assert.equal(refusal?.code, 'ACCEPTANCE_BLOCKED');
    assert.match(refusal!.message, /unresolved verification failure/);

    await services.db.projectBlocker.create({
      data: {
        projectId: target.projectId,
        kind: 'PROVIDER_UNAVAILABLE',
        owner: 'USER',
        recovery: 'HUMAN',
        severity: 'CRITICAL',
        requiredAction: 'configure a provider',
        nextCheckAt: new Date(Date.now() + 60_000),
        subjectType: 'PROJECT',
        subjectId: target.projectId,
        dedupeKey: `provider:${target.projectId}`,
        lifecycleGeneration: 1n,
        conditionVersion: 'c'.repeat(64),
        firstSeenAt: new Date(),
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      },
    });
    assert.equal(
      (await refusalOf(() => services.projects.update(
        target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never)))?.code,
      'ACCEPTANCE_BLOCKED',
    );
  });

  await t.test('a consistent PASS settles the project, exactly once', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'passing', { acceptanceCriteria: CRITERIA });
    await task(services.db, target, 'the work', { status: TaskStatus.DONE });
    const run = await passing(services, target.ownerId, target.projectId);
    assert.equal(run.verdict, 'PASS');
    assert.equal(run.criteria.every((c) => c.verdict === 'PASS'), true);
    assert.ok(run.resultDigest, 'a concluded run carries the digest of what it concluded');

    const settled = await services.projects.update(
      target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never);
    assert.equal(settled.status, ProjectStatus.DONE);
    assert.equal(settled.acceptedRunId, run.id, 'DONE and its evidence are one row');

    // Pressing the button again is the same request, not a second settlement: one binding, one
    // audit row. (A retry, a double click and a re-delivered command all look like this.)
    const again = await services.projects.update(
      target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never);
    assert.equal(again.acceptedRunId, run.id);
    const bound = await services.db.projectAcceptanceAudit.findMany({
      where: { projectId: target.projectId, kind: 'done_bound' },
    });
    assert.equal(bound.length, 1, 'a repeated DONE must not write a second binding');
  });

  await t.test('two concurrent DONE writes produce one settlement', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'concurrent', { acceptanceCriteria: CRITERIA });
    const run = await passing(services, target.ownerId, target.projectId);

    // Both go through the same `FOR UPDATE` (§13.4 AE7), so one waits for the other; whichever
    // arrives second re-reads a project that is already DONE and does not bind again.
    const results = await Promise.allSettled([
      services.projects.update(target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never),
      services.projects.update(target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
    const bound = await services.db.projectAcceptanceAudit.findMany({
      where: { projectId: target.projectId, kind: 'done_bound' },
    });
    assert.equal(bound.length, 1);
    assert.equal(
      (await services.db.project.findUniqueOrThrow({ where: { id: target.projectId } })).acceptedRunId,
      run.id,
    );
  });

  await t.test('a fact that changes after a PASS makes that PASS stale, not usable', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'stale', { acceptanceCriteria: CRITERIA });
    const done = await task(services.db, target, 'the work', { status: TaskStatus.DONE });
    await passing(services, target.ownerId, target.projectId);

    // AE4: nothing invalidates the old record — it simply stops describing this world.
    await services.db.task.update({ where: { id: done }, data: { status: TaskStatus.OPEN } });
    const refusal = await refusalOf(() =>
      services.projects.update(target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never));
    assert.equal(refusal?.code, 'ACCEPTANCE_EVIDENCE_STALE');

    // ...and putting it back makes the same record match again, which is correct rather than a
    // hole: the world is the one that record described (AE4's last sentence).
    await services.db.task.update({ where: { id: done }, data: { status: TaskStatus.DONE } });
    const settled = await services.projects.update(
      target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never);
    assert.equal(settled.status, ProjectStatus.DONE);
  });

  await t.test('changing the merge baseline makes a PASS stale', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'merge-baseline', { acceptanceCriteria: CRITERIA });
    const first = await services.acceptance.recordMergeEvidence(target.ownerId, target.projectId, {
      requirementId: 'feat/project', targetBranch: 'main', contentHash: HASH_A,
    });
    assert.equal(first.refGeneration, '1');
    assert.equal(first.changed, true);

    // AE9-b: the same content is an observation, not a change — the generation must not move, or
    // every re-check would invalidate the evidence it was confirming.
    const again = await services.acceptance.recordMergeEvidence(target.ownerId, target.projectId, {
      requirementId: 'feat/project', targetBranch: 'main', contentHash: HASH_A,
    });
    assert.equal(again.refGeneration, '1');
    assert.equal(again.changed, false);

    await passing(services, target.ownerId, target.projectId);
    const moved = await services.acceptance.recordMergeEvidence(target.ownerId, target.projectId, {
      requirementId: 'feat/project', targetBranch: 'main', contentHash: HASH_B,
    });
    assert.equal(moved.refGeneration, '2');
    assert.equal(
      (await refusalOf(() => services.projects.update(
        target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never)))?.code,
      'ACCEPTANCE_EVIDENCE_STALE',
    );
  });

  await t.test('a fact write after DONE reopens the project atomically (AE8)', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'reopen-by-fact', { acceptanceCriteria: CRITERIA });
    const done = await task(services.db, target, 'the work', { status: TaskStatus.DONE });
    const run = await passing(services, target.ownerId, target.projectId);
    await services.projects.update(target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never);

    // A raw task write — the shape every future migration and every older binary takes. The
    // service knows nothing about it; the database does.
    await services.db.$executeRawUnsafe(
      `UPDATE "task" SET "status" = 'OPEN' WHERE "id" = $1::uuid`, done,
    );

    const after = await services.db.project.findUniqueOrThrow({ where: { id: target.projectId } });
    assert.equal(after.status, ProjectStatus.OPEN, 'DONE + a changed fact is not a reachable state');
    assert.equal(after.acceptedRunId, null);
    const retired = await services.db.projectAcceptanceRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(retired.supersededReason, 'reopened_by_fact_change:task.status_changed');
    const audit = await services.db.projectAcceptanceAudit.findFirst({
      where: { projectId: target.projectId, kind: 'reopened_by_fact_change' },
    });
    assert.equal(audit?.reason, 'task.status_changed');
    // §5.3's dirty signal, so reconcile recomputes `run_state` off the reopened row.
    const event = await services.db.projectEvent.findFirst({
      where: { projectId: target.projectId, kind: 'user.project_edited' },
    });
    assert.ok(event, 'a reopen must ask the control loop to look again');
  });

  await t.test('a new merge observation after DONE reopens the project (AE9-c)', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'reopen-by-merge', { acceptanceCriteria: CRITERIA });
    await services.acceptance.recordMergeEvidence(target.ownerId, target.projectId, {
      requirementId: 'feat/project', targetBranch: 'main', contentHash: HASH_A,
    });
    await passing(services, target.ownerId, target.projectId);
    await services.projects.update(target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never);

    await services.acceptance.recordMergeEvidence(target.ownerId, target.projectId, {
      requirementId: 'feat/project', targetBranch: 'main', contentHash: HASH_B,
      detail: { command: 'git grep', note: 'force-pushed' },
    });
    const after = await services.db.project.findUniqueOrThrow({ where: { id: target.projectId } });
    assert.equal(after.status, ProjectStatus.OPEN);
    const audit = await services.db.projectAcceptanceAudit.findFirst({
      where: { projectId: target.projectId, kind: 'reopened_by_fact_change' },
    });
    assert.equal(audit?.reason, 'merge_evidence');
  });

  await t.test('reopening a project retires its PASS, so the old one cannot be reused', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'reopen-by-user', { acceptanceCriteria: CRITERIA });
    const run = await passing(services, target.ownerId, target.projectId);
    await services.projects.update(target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never);

    // Nothing else changes here — no task, no verdict, no criteria, no branch — so the DIGEST is
    // identical afterwards. AE4's "the digest stops matching" does not cover this case, which is
    // why reopening is the one invalidation that has to be written rather than derived.
    await services.projects.update(target.ownerId, target.projectId, { status: ProjectStatus.OPEN } as never);
    const retired = await services.db.projectAcceptanceRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(retired.supersededReason, 'reopened_by_user');
    assert.equal(retired.verdict, 'PASS', 'the conclusion itself is not rewritten, only retired');

    const refusal = await refusalOf(() =>
      services.projects.update(target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never));
    assert.equal(refusal?.code, 'ACCEPTANCE_MISSING');

    // A new attempt is what reopens the door.
    const second = await passing(services, target.ownerId, target.projectId);
    assert.notEqual(second.id, run.id);
    const settled = await services.projects.update(
      target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never);
    assert.equal(settled.acceptedRunId, second.id);
  });

  await t.test('a concluded run and its criteria cannot be rewritten', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'immutable', { acceptanceCriteria: CRITERIA });
    const run = await passing(services, target.ownerId, target.projectId);

    await assert.rejects(
      () => services.db.$executeRawUnsafe(
        `UPDATE "project_acceptance_run" SET "verdict" = 'FAIL' WHERE "id" = $1::uuid`, run.id),
      /ACCEPTANCE_RUN_IMMUTABLE/,
    );
    await assert.rejects(
      () => services.db.$executeRawUnsafe(
        `UPDATE "project_acceptance_criterion" SET "verdict" = 'FAIL' WHERE "run_id" = $1::uuid`, run.id),
      /ACCEPTANCE_RUN_IMMUTABLE/,
    );
    await assert.rejects(
      () => services.acceptance.finalizeRun(target.ownerId, target.projectId, run.id, [
        { ordinal: 1, verdict: 'FAIL' },
      ]),
      /already concluded PASS/,
    );
    const audit = await services.db.projectAcceptanceAudit.findFirstOrThrow({
      where: { projectId: target.projectId, kind: 'run_finalized' },
    });
    await assert.rejects(
      () => services.db.$executeRawUnsafe(
        `UPDATE "project_acceptance_audit" SET "reason" = 'edited' WHERE "id" = $1::uuid`, audit.id),
      /ACCEPTANCE_AUDIT_APPEND_ONLY/,
    );
  });

  await t.test('the database refuses a DONE nobody went through the service for', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'raw-done', { acceptanceCriteria: CRITERIA });

    // The service-layer gate lives in whichever binary has it. This is the wall behind it, and it
    // is the only one an older apiserver, a migration script or a hand-typed UPDATE meets.
    await assert.rejects(
      () => services.db.$executeRawUnsafe(
        `UPDATE "project" SET "status" = 'DONE' WHERE "id" = $1::uuid`, target.projectId),
      /project_done_evidence_chk|ACCEPTANCE_MISSING/,
    );

    const run = await passing(services, target.ownerId, target.projectId);
    await services.db.$executeRawUnsafe(
      `UPDATE "project_acceptance_run" SET "superseded_at" = CURRENT_TIMESTAMP WHERE "id" = $1::uuid`,
      run.id,
    );
    await assert.rejects(
      () => services.db.$executeRawUnsafe(
        `UPDATE "project" SET "status" = 'DONE', "accepted_run_id" = $2::uuid WHERE "id" = $1::uuid`,
        target.projectId, run.id),
      /ACCEPTANCE_EVIDENCE_STALE/,
    );
  });

  await t.test('a legacy DONE keeps its DONE, is labelled as legacy, and is not reopened', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'legacy', { acceptanceCriteria: CRITERIA });
    const done = await task(services.db, target, 'old work', { status: TaskStatus.DONE });

    // A project settled by a pre-0127 binary: DONE, no run, no stamp. The constraint that makes
    // that unreachable is dropped for exactly as long as it takes to create the row it was written
    // to describe — which is what the rows in a real database looked like before this migration.
    await services.db.$executeRawUnsafe(
      `ALTER TABLE "project" DROP CONSTRAINT "project_done_evidence_chk"`);
    await services.db.$executeRawUnsafe(
      `ALTER TABLE "project" DISABLE TRIGGER "project_acceptance_done_gate"`);
    await services.db.$executeRawUnsafe(
      `UPDATE "project" SET "status" = 'DONE' WHERE "id" = $1::uuid`, target.projectId);
    await services.db.$executeRawUnsafe(
      `ALTER TABLE "project" ENABLE TRIGGER "project_acceptance_done_gate"`);

    // The migration's own backfill and constraint, replayed verbatim from the file.
    const backfill = MIGRATION.slice(MIGRATION.indexOf('UPDATE "project" SET "legacy_accepted_at"'));
    for (const statement of backfill.split(/;\s*\n/).slice(0, 3)) {
      await services.db.$executeRawUnsafe(statement);
    }

    const stamped = await services.db.project.findUniqueOrThrow({ where: { id: target.projectId } });
    assert.equal(stamped.status, ProjectStatus.DONE, 'AC11: an upgrade does not reopen finished work');
    assert.ok(stamped.legacyAcceptedAt, 'a DONE that predates the mechanism is labelled, not credited');
    assert.equal(stamped.acceptedRunId, null);
    const marked = await services.db.projectAcceptanceAudit.findFirst({
      where: { projectId: target.projectId, kind: 'legacy_marked' },
    });
    assert.match(marked?.reason ?? '', /predates native project acceptance/);

    // A fact change does NOT reopen it: it never claimed to be bound to a set of facts, so no fact
    // can contradict it. Reopening somebody's finished project during an upgrade is the
    // destructive reading of "compatibility".
    await services.db.task.update({ where: { id: done }, data: { status: TaskStatus.OPEN } });
    assert.equal(
      (await services.db.project.findUniqueOrThrow({ where: { id: target.projectId } })).status,
      ProjectStatus.DONE,
    );

    const overview = await services.acceptance.overview(target.ownerId, target.projectId);
    assert.equal(overview.legacyEvidence, true, 'the read face says so out loud');
    assert.equal(overview.doneGate.allowed, false);

    // ...but the label expires the moment a person reopens it: the next DONE has to earn a run.
    await services.projects.update(target.ownerId, target.projectId, { status: ProjectStatus.OPEN } as never);
    const reopened = await services.db.project.findUniqueOrThrow({ where: { id: target.projectId } });
    assert.equal(reopened.legacyAcceptedAt, null);
    assert.equal(
      (await refusalOf(() => services.projects.update(
        target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never)))?.code,
      'ACCEPTANCE_MISSING',
    );
  });

  await t.test('the read face is non-empty, machine-readable and Base62', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'read-face', { acceptanceCriteria: CRITERIA });
    const subject = await task(services.db, target, 'the work', { status: TaskStatus.DONE });
    await task(services.db, target, 'the check', {
      // As above, and PASS here: this scenario ends with the DONE gate allowed, which is what a
      // finished check that concluded nothing could never have supported.
      status: TaskStatus.DONE, verifiesTaskId: subject, verdict: 'PASS',
    });
    await services.acceptance.recordMergeEvidence(target.ownerId, target.projectId, {
      requirementId: 'feat/project', targetBranch: 'main', contentHash: HASH_A,
      detail: { command: 'git grep -c acceptanceDigest' },
    });
    const run = await passing(services, target.ownerId, target.projectId);
    await services.projects.update(target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never);

    const overview = await services.acceptance.overview(target.ownerId, target.projectId);
    assert.equal(overview.runs.length, 1);
    assert.equal(overview.runs[0].criteria.length, 3);
    assert.equal(overview.runs[0].criteria[0].evidence !== null, true);
    assert.equal(overview.mergeEvidence.length, 1);
    assert.equal(overview.doneGate.allowed, true);
    assert.equal(overview.doneGate.runId, run.id);
    assert.equal(overview.acceptanceDigest, overview.runs[0].inputDigest);
    assert.ok(overview.audit.length >= 3, 'the audit records opening, concluding and binding');

    const verifications = await services.projects.verifications(target.ownerId, target.projectId);
    assert.equal(verifications.verifications.length, 1);
    const status = await services.projects.coordinatorStatus(target.ownerId, target.projectId);
    assert.equal(status.acceptance.run?.verdict, 'PASS');
    assert.equal(status.acceptance.doneGate.allowed, true);

    for (const [name, payload] of [
      ['acceptance', overview],
      ['verifications', verifications],
      ['coordinatorStatus', status],
    ] as Array<[string, unknown]>) {
      const leaked = rawUuidPaths(await servePublicIds(payload), `$.${name}`);
      assert.deepEqual(leaked, [], `${name} must serve Base62 ids only — leaked ${leaked.join(', ')}`);
    }
  });

  await t.test('an acceptance a person recorded is kept, and does not open the gate by itself', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'by-hand', { acceptanceCriteria: CRITERIA });
    const open = await services.acceptance.openRun(target.ownerId, target.projectId, { decidedBy: 'USER' });
    const run = await services.acceptance.finalizeRun(
      target.ownerId, target.projectId, open.id,
      open.criteria.map((c) => ({ ordinal: c.ordinal, verdict: 'PASS' as const })),
    );
    assert.equal(run.verdict, 'PASS');
    assert.equal(run.decidedBy, 'USER');

    const refusal = await refusalOf(() =>
      services.projects.update(target.ownerId, target.projectId, { status: ProjectStatus.DONE } as never));
    assert.equal(refusal?.code, 'ACCEPTANCE_MISSING');
    assert.match(refusal!.message, /concluded by USER/);

    // The record is not deleted or downgraded — it is a real check somebody really ran. What it is
    // not is the coordinator's conclusion, which is what §13.4 AE2 step 2 asks for.
    const kept = await services.db.projectAcceptanceRun.findUniqueOrThrow({ where: { id: run.id } });
    assert.equal(kept.verdict, 'PASS');
  });

  await t.test('acceptance is tenant-scoped, and a project with no criteria cannot pass', async () => {
    await emptyWorld(identity);
    const mine = await world(services.db, 'mine', { acceptanceCriteria: CRITERIA });
    const theirs = await world(services.db, 'theirs', { acceptanceCriteria: CRITERIA });

    await assert.rejects(
      () => services.acceptance.overview(theirs.ownerId, mine.projectId), /project not found/);
    await assert.rejects(
      () => services.acceptance.openRun(theirs.ownerId, mine.projectId, { decidedBy: 'USER' }),
      /project not found/);
    await assert.rejects(
      () => services.acceptance.recordMergeEvidence(theirs.ownerId, mine.projectId, {
        requirementId: 'r', targetBranch: 'main', contentHash: HASH_A,
      }),
      /project not found/);

    const blank = await world(services.db, 'blank');
    await assert.rejects(
      () => services.acceptance.openRun(blank.ownerId, blank.projectId, { decidedBy: 'USER' }),
      /states no acceptance criteria/,
    );
  });

  await t.test('the attempt epoch is monotonic and never reused', async () => {
    await emptyWorld(identity);
    const target = await world(services.db, 'epoch', { acceptanceCriteria: CRITERIA });
    const first = await services.acceptance.openRun(target.ownerId, target.projectId, { decidedBy: 'USER' });
    const second = await services.acceptance.openRun(target.ownerId, target.projectId, { decidedBy: 'USER' });
    assert.equal(first.attempt, '0');
    assert.equal(second.attempt, '1');
    // Opening a newer attempt retires the older one: two usable runs would let a caller pick the
    // conclusion they prefer.
    const retired = await services.db.projectAcceptanceRun.findUniqueOrThrow({ where: { id: first.id } });
    assert.equal(retired.supersededReason, 'superseded_by_newer_attempt');
    const runtime = await services.db.projectRuntime.findUniqueOrThrow({
      where: { projectId: target.projectId },
    });
    assert.equal(runtime.acceptanceAttempt, 2n);
  });
});
