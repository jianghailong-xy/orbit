/**
 * A submission for a task that states no standard at all — no declared criterionKey and empty
 * acceptanceCriteria — is refused synchronously with a 4xx that says what to do, and nothing is
 * written (docs/evidence-always-has-an-addressee-design.md §2.3). Before, it was accepted and left
 * undecidable: no decider could hold it against anything, and the one who could fix it, the
 * submitter, was never told.
 *
 * Destructive: it truncates. COORDINATOR_PG_URL must name the disposable guarded database with
 * current migrations applied.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ConflictException } from '@nestjs/common';
import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
  TaskStatus,
} from '@prisma/client';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';

const URL = process.env.COORDINATOR_PG_URL;
const suite = URL ? test : test.skip;

async function empty(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`
    TRUNCATE "task", "session", "project", "workspace", "runner", "user"
    RESTART IDENTITY CASCADE
  `);
}

/** One running task and the session doing its work, with a tool call the evidence can cite. */
async function fixture(db: PrismaClient, opts: { inProject: boolean; acceptanceCriteria: string | null }) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = opts.inProject ? randomUUID() : null;
  const taskId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `nostd-${ownerId}@invalid.test`, name: 'No standard', passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: 'nostd-runner', tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'nostd-workspace', enabled: true },
  });
  if (projectId) await db.project.create({ data: { id: projectId, ownerId, title: 'A project with criteria' } });
  await db.task.create({
    data: {
      id: taskId,
      ownerId,
      projectId,
      title: 'work with no standard',
      creatorType: CreatorType.USER,
      completionCriterion: 'EVIDENCE_JUDGMENT',
      creatorId: ownerId,
      assigneeId: workspaceId,
      status: TaskStatus.IN_PROGRESS,
      acceptanceCriteria: opts.acceptanceCriteria,
    },
  });
  await db.session.create({
    data: {
      id: sessionId,
      ownerId,
      creatorId: ownerId,
      taskId,
      workspaceId,
      assignedRunnerId: runnerId,
      title: 'the run',
      prompt: 'run the task',
      provider: 'claude',
      status: RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  await db.toolCall.create({
    data: {
      sessionId,
      name: 'Bash',
      toolUseId: `toolu_nostd_${taskId.slice(0, 8)}`,
      input: { command: 'npm test', description: 'the check' },
      isError: false,
    },
  });
  return { ownerId, workspaceId, taskId, sessionId, toolUseId: `toolu_nostd_${taskId.slice(0, 8)}` };
}

suite('a task that states no standard has its evidence refused at submit, with nothing written', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });
  await empty(sql);
  const service = new TaskCompletionEvidenceService(db as unknown as PrismaService);

  const cases = [
    { name: 'a project task with no criterionKey and no acceptanceCriteria', inProject: true, acceptanceCriteria: null },
    { name: 'a project task whose acceptanceCriteria are blank', inProject: true, acceptanceCriteria: ' \n\t ' },
    { name: 'a task in no project with no acceptanceCriteria', inProject: false, acceptanceCriteria: null },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const f = await fixture(db, c);
      const before = await db.task.findUniqueOrThrow({ where: { id: f.taskId } });
      const evidence = {
        claim: 'the work is done',
        // What a run told to copy a project criterion would have sent.
        criterion: { key: 'some-project-criterion', text: 'some text' },
        checks: [{ kind: 'TOOL_CALL', ref: f.toolUseId, command: 'npm test', succeeded: true }],
        gaps: [],
      };
      await assert.rejects(
        service.submit(f.ownerId, f.taskId, { type: CreatorType.AGENT, id: f.workspaceId }, {
          sourceSessionId: f.sessionId,
          evidence,
          idempotencyKey: 'no-standard-1',
        }),
        (error: unknown) => {
          assert.ok(error instanceof ConflictException, String(error));
          assert.equal(error.getStatus(), 409);
          const body = error.getResponse() as { code: string; message: string; requiredAction: string };
          assert.equal(body.code, 'TASK_STATES_NO_STANDARD');
          assert.equal(body.requiredAction, 'WRITE_ACCEPTANCE_CRITERIA_OR_DECLARE_CRITERION_KEY');
          assert.match(body.message, /Write the task's acceptanceCriteria \(task_update\) or declare a criterionKey/);
          return true;
        },
      );
      // Nothing written: no revision, no retry key bound, the task row untouched.
      assert.equal(await db.taskCompletionEvidence.count({ where: { taskId: f.taskId } }), 0);
      assert.equal(await db.taskCompletionEvidenceIdempotency.count({ where: { taskId: f.taskId } }), 0);
      assert.deepEqual(await db.task.findUniqueOrThrow({ where: { id: f.taskId } }), before);

      // The control: once the task states a standard, the same submission is taken.
      await db.task.update({ where: { id: f.taskId }, data: { acceptanceCriteria: 'npm test passes' } });
      const taken = await service.submit(f.ownerId, f.taskId, { type: CreatorType.AGENT, id: f.workspaceId }, {
        sourceSessionId: f.sessionId,
        evidence,
        idempotencyKey: 'no-standard-2',
      });
      assert.equal(taken.revision, '1');
      assert.equal(await db.taskCompletionEvidence.count({ where: { taskId: f.taskId } }), 1);
    });
  }
});
