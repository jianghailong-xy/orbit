/**
 * A gap can name the clause of the task's standard it leaves unproven, and CONFIRM is refused while
 * such a gap has no follow-up task (docs/evidence-always-has-an-addressee-design.md §6, owner
 * decision D4). Before, gaps were free text and a gap that hit the standard could be accepted as
 * it stood: the 2026-11-12 parity clause was confirmed as an "accepted gap" with nobody to prove it.
 *
 * Pinned here, against real PostgreSQL, through the service the API wires:
 *  - a clause-naming gap with no follow-up: CONFIRM refused, nothing written, SEND_BACK still taken;
 *    the next revision naming a follow-up in the same project is CONFIRMed and the task is DONE;
 *  - a plain-text gap (no `gapClauses`): CONFIRM taken exactly as before;
 *  - at submit time, a follow-up that is not a task of this project is refused with nothing written;
 *  - at the door, a follow-up that has gone since submission refuses CONFIRM again;
 *  - the pending row keeps `gaps` as plain strings and carries `gapClauses` beside them.
 *
 * Refusal bodies are read structurally and the codes are literals, so a build without the rule
 * fails these assertions rather than failing to compile.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';
import { uuidToBase62 } from '@orbit/shared';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

const STANDARD = 'the cards work on web and on a phone';
const CLAUSE = 'on a phone';
const GAP = 'Physical phones were not checked.';

interface RefusalView {
  code?: string;
  requiredAction?: string;
  message?: string;
}

/** One project with a judged task, a follow-up in the same project and a task in another; the run
 * that did the work and a coordinator session that did not. */
async function fixture(db: PrismaClient) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  const taskId = randomUUID();
  const followUpId = randomUUID();
  const elsewhereId = randomUUID();
  const workerSessionId = randomUUID();
  const coordinatorSessionId = randomUUID();
  const toolUseId = `toolu_gap_${taskId.slice(0, 8)}`;
  await db.user.create({
    data: { id: ownerId, email: `gap-${ownerId}@invalid.test`, name: 'Gap', passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: 'gap-runner', tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'gap-workspace', enabled: true } });
  await db.project.create({ data: { id: projectId, ownerId, title: 'the project the work is in' } });
  await db.project.create({ data: { id: otherProjectId, ownerId, title: 'another project' } });
  const task = (id: string, project: string, title: string) => db.task.create({
    data: {
      id,
      ownerId,
      projectId: project,
      title,
      creatorType: CreatorType.USER,
      creatorId: ownerId,
      assigneeId: workspaceId,
      status: TaskStatus.OPEN,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      acceptanceCriteria: STANDARD,
    },
  });
  await task(taskId, projectId, 'the judged work');
  await task(followUpId, projectId, 'prove it on a phone');
  await task(elsewhereId, otherProjectId, 'a task in another project');
  const session = (id: string, forTask: string | null, title: string) => db.session.create({
    data: {
      id,
      ownerId,
      creatorId: ownerId,
      taskId: forTask,
      workspaceId,
      assignedRunnerId: runnerId,
      title,
      prompt: title,
      provider: 'claude',
      status: RunStatus.AWAITING_INPUT,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: forTask !== null,
    },
  });
  await session(workerSessionId, taskId, 'the run that did the work');
  await session(coordinatorSessionId, null, 'the coordinator');
  await db.toolCall.create({
    data: { sessionId: workerSessionId, name: 'Bash', toolUseId, input: { command: 'npm test' }, isError: false },
  });
  return { ownerId, workspaceId, taskId, followUpId, elsewhereId, workerSessionId, coordinatorSessionId, toolUseId };
}

async function refusalOf(run: () => Promise<unknown>): Promise<RefusalView & { status: number }> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof HttpException, `expected a refusal, got ${error}`);
    return { ...(error.getResponse() as RefusalView), status: error.getStatus() };
  }
  throw new assert.AssertionError({ message: 'expected a refusal; the call was accepted' });
}

suite('a gap that names a clause of the standard needs a follow-up task before CONFIRM', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await verifyCoordinatorPgIdentity(sql);
  await sql.query('TRUNCATE "task", "session", "project", "workspace", "runner", "user" RESTART IDENTITY CASCADE');
  const service = new TaskCompletionEvidenceService(db as unknown as PrismaService);

  function harness(f: Awaited<ReturnType<typeof fixture>>) {
    const actor = { type: CreatorType.AGENT, id: f.workspaceId } as const;
    return {
      submit: (evidence: Record<string, unknown>) => service.submit(f.ownerId, f.taskId, actor, {
        sourceSessionId: f.workerSessionId,
        evidence: { claim: 'the cards work', checks: [{ kind: 'TOOL_CALL', ref: f.toolUseId }], ...evidence },
      }),
      decide: (evidenceRevision: string, decision: 'CONFIRM' | 'SEND_BACK', note?: string) => service.decide(
        f.ownerId, f.taskId, actor,
        { decidingSessionId: f.coordinatorSessionId, evidenceRevision, decision, ...(note ? { note } : {}) },
      ),
      status: async () => (await db.task.findUniqueOrThrow({ where: { id: f.taskId } })).status,
      decisions: () => db.taskEvidenceDecision.count({ where: { taskId: f.taskId } }),
      revisions: () => db.taskCompletionEvidence.count({ where: { taskId: f.taskId } }),
    };
  }

  await t.test('CONFIRM is refused for a clause-naming gap with no follow-up; SEND_BACK is not; a follow-up lets it through', async () => {
    const f = await fixture(db);
    const h = harness(f);
    const first = await h.submit({ gaps: [GAP], gapClauses: [{ gap: 0, criterionClause: CLAUSE }] });
    assert.equal(first.revision, '1');

    const refused = await refusalOf(() => h.decide('1', 'CONFIRM'));
    assert.equal(refused.status, 409);
    assert.equal(refused.code, 'EVIDENCE_JUDGMENT_GAP_WITHOUT_FOLLOW_UP');
    assert.equal(refused.requiredAction, 'SEND_BACK_OR_ASK_FOR_A_FOLLOW_UP_TASK');
    assert.match(refused.message ?? '', /gaps\[0\]: "on a phone"/);
    assert.equal(await h.decisions(), 0, 'a refused CONFIRM writes no decision');
    assert.equal(await h.status(), TaskStatus.OPEN);

    const sentBack = await h.decide('1', 'SEND_BACK', 'File a task that proves it on a phone and name it in gapClauses.');
    assert.equal(sentBack.decision, 'SEND_BACK');
    assert.equal(await h.decisions(), 1);

    const second = await h.submit({
      gaps: [GAP],
      gapClauses: [{ gap: 0, criterionClause: CLAUSE, followUpTaskId: uuidToBase62(f.followUpId) }],
    });
    assert.equal(second.revision, '2');
    const confirmed = await h.decide('2', 'CONFIRM');
    assert.equal(confirmed.decision, 'CONFIRM');
    assert.equal(await h.status(), TaskStatus.DONE);
  });

  await t.test('a plain-text gap does not block CONFIRM', async () => {
    const f = await fixture(db);
    const h = harness(f);
    await h.submit({ gaps: [GAP] });
    const confirmed = await h.decide('1', 'CONFIRM');
    assert.equal(confirmed.decision, 'CONFIRM');
    assert.equal(await h.status(), TaskStatus.DONE);
  });

  await t.test('a follow-up that is not a task of this project is refused at submit, with nothing written', async () => {
    const f = await fixture(db);
    const h = harness(f);
    const cases = [
      { ref: uuidToBase62(f.elsewhereId), why: /is a task in another project/ },
      { ref: uuidToBase62(randomUUID()), why: /names no task of this account/ },
      { ref: uuidToBase62(f.taskId), why: /names this task itself/ },
    ];
    for (const c of cases) {
      const refused = await refusalOf(() => h.submit({
        gaps: [GAP],
        gapClauses: [{ gap: 0, criterionClause: CLAUSE, followUpTaskId: c.ref }],
      }));
      assert.equal(refused.status, 400);
      assert.equal(refused.code, 'EVIDENCE_GAP_FOLLOW_UP_INVALID');
      assert.equal(refused.requiredAction, 'NAME_A_FOLLOW_UP_TASK_IN_THIS_PROJECT');
      assert.match(refused.message ?? '', c.why);
    }
    // And a mark that points at no gap is a shape refusal.
    const outOfRange = await refusalOf(() => h.submit({ gaps: [GAP], gapClauses: [{ gap: 1, criterionClause: CLAUSE }] }));
    assert.equal(outOfRange.code, 'EVIDENCE_ENVELOPE_INVALID');
    assert.equal(await h.revisions(), 0);
  });

  await t.test('a follow-up gone since submission refuses CONFIRM at the door', async () => {
    const f = await fixture(db);
    const h = harness(f);
    await h.submit({
      gaps: [GAP],
      gapClauses: [{ gap: 0, criterionClause: CLAUSE, followUpTaskId: uuidToBase62(f.followUpId) }],
    });
    await db.task.delete({ where: { id: f.followUpId } });
    const refused = await refusalOf(() => h.decide('1', 'CONFIRM'));
    assert.equal(refused.code, 'EVIDENCE_JUDGMENT_GAP_WITHOUT_FOLLOW_UP');
    assert.match(refused.message ?? '', /names no task of this account/);
    assert.equal(await h.decisions(), 0);
  });

  await t.test('the pending row keeps gaps as plain text and carries gapClauses beside them', async () => {
    const f = await fixture(db);
    const h = harness(f);
    await h.submit({ gaps: [GAP, 'Dark mode was not looked at.'], gapClauses: [{ gap: 0, criterionClause: CLAUSE }] });
    const queue = await service.pending(f.ownerId, f.coordinatorSessionId);
    const row = [...queue.pending, ...queue.waitingOnCoordinator].find((candidate) => candidate.taskId === f.taskId);
    assert.ok(row, 'the revision is pending for the coordinator');
    assert.deepEqual(row.gaps, [GAP, 'Dark mode was not looked at.']);
    assert.ok(row.gaps.every((gap) => typeof gap === 'string'));
    assert.deepEqual(row.gapClauses, [{ gap: 0, criterionClause: CLAUSE }]);
    assert.equal(row.decidability.decidable, true, 'SEND_BACK can still be recorded, so the row stays decidable');
  });
});
