/**
 * §13.1 and §13.2 through the doors a caller actually has, against a real PostgreSQL.
 *
 * The unit specs beside this one prove the plan is right. This one proves the plan RUNS — and it
 * exists because for one release it did not. `planTaskAggregation` was complete, correct and
 * applied in exactly one place: inside a reconcile, which only happens for a Project whose
 * coordinator is switched on. Every project in this deployment has it switched off. So a phase
 * parent set to ALL_CHILDREN_DONE sat at OPEN with all of its subtasks finished, and the only way
 * to close it was the status write the policy exists to replace.
 *
 * Everything here therefore goes through `TasksService` — the same object the user PATCH, the CLI
 * and the MCP tool all end up in — with the coordinator deliberately DISABLED, so what is being
 * measured is what a caller with no control loop actually gets.
 *
 * Destructive: it truncates. It refuses to run anywhere but the disposable server the guard in
 * coordinator-pg-test-safety identifies (see docs/project-coordinator-validation-*.md for how one
 * is provisioned).
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CreatorType,
  PrismaClient,
  RunStatus,
  RunnerStatus,
  TaskCompletionPolicy,
  TaskVerdict,
} from '@prisma/client';
import { Client } from 'pg';
// The status enum comes from @orbit/shared rather than from Prisma: it is what the DTOs are typed
// against, and the two spell the same values.
import { TaskStatus, uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { ProjectAcceptanceService } from '../projects/project-acceptance.service';
import { establishProjectContractForPgTest } from '../projects/project-contract-test-helper';
import { ProjectsService } from '../projects/projects.service';
import { TaskCompletionEvidenceService } from './task-completion-evidence.service';
import { completeHumanTaskForPgTest } from './task-completion-test-helper';
import { TasksService } from './tasks.service';
import { prismaClientFor } from '../prisma/prisma-client';

const URL = process.env.COORDINATOR_PG_URL;

interface World {
  ownerId: string;
  projectId: string;
  otherProjectId: string;
  workspaceId: string;
}

/** Every task change this run published, so "the caller was told" is checkable, not assumed. */
const published: Array<{ ownerId: string; taskId: string }> = [];

function tasksService(db: PrismaClient): TasksService {
  const realtime = {
    publishTaskChanged: () => {},
    publishForUser: (
      ownerId: string,
      _type: unknown,
      change: { taskIds?: string[] },
    ) => {
      for (const taskId of change.taskIds ?? []) published.push({ ownerId, taskId });
    },
  };
  // Nothing here dispatches: every fixture task is unassigned, which is what makes `execute` and
  // `fileVerification` unreachable. A stub that throws would say so loudly if that ever changed.
  const sessions = {
    create: () => {
      throw new Error('no fixture in this spec should start a run');
    },
    cancel: async () => {},
  };
  return new TasksService(db as unknown as PrismaService, sessions as any, realtime as any);
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const otherProjectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@pcc25b.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: `${label}-runner`, tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true },
  });
  for (const [id, title] of [[projectId, label], [otherProjectId, `${label}-other`]] as const) {
    // coordinatorEnabled stays false — its default, and every existing project's value. That is
    // the whole point: aggregation has to work without one.
    await db.project.create({ data: { id, ownerId, title } });
    await db.projectRuntime.upsert({ where: { projectId: id }, create: { projectId: id }, update: {} });
    await establishProjectContractForPgTest(db, ownerId, id, title);
  }
  return { ownerId, projectId, otherProjectId, workspaceId };
}

async function emptyWorld(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  published.length = 0;
  await client.query(`
    TRUNCATE "project_action", "project_runtime",
             "task", "session", "workspace", "runner", "project", "user"
    RESTART IDENTITY CASCADE
  `);
}

async function statusOf(db: PrismaClient, id: string): Promise<string> {
  const row = await db.task.findUniqueOrThrow({ where: { id }, select: { status: true } });
  return row.status;
}

/** Complete an ordinary VERIFICATION subject through the fact that actually derives DONE. */
async function passViaIndependentVerifier(
  tasks: TasksService,
  ownerId: string,
  projectId: string,
  subjectId: string,
  label: string,
): Promise<string> {
  const verifier = await tasks.create(ownerId, {
    title: `[FIXTURE VERIFY] ${label}`,
    projectId,
    verifiesTaskId: subjectId,
    completionCriterion: 'VERIFICATION',
  });
  await tasks.update(ownerId, verifier.id, { verdict: TaskVerdict.PASS });
  return verifier.id;
}

/** Revoke the fact above; the subject and any aggregate ancestors must derive OPEN again. */
async function revokeVerifierPass(
  tasks: TasksService,
  ownerId: string,
  verifierId: string,
): Promise<void> {
  await tasks.update(ownerId, verifierId, { verdict: null });
}

/** The refusal `fn` produced, or '' if it did not refuse — so a test can assert on the reason. */
async function message(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  return '';
}

const suite = URL ? test : test.skip;

suite('verification relations and phase aggregation, on real PostgreSQL', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  const db = prismaClientFor(URL);
  t.after(async () => {
    await db.$disconnect();
    await client.end();
  });

  // ---------------------------------------------------------------------------------------
  // The door
  // ---------------------------------------------------------------------------------------

  await t.test('a check is filed at a subject and reads back in base62', async () => {
    await emptyWorld(client);
    const w = await world(db, 'door');
    const tasks = tasksService(db);

    const subject = await tasks.create(w.ownerId, { title: 'Ship the importer', projectId: w.projectId });
    const check = await tasks.create(w.ownerId, {
      title: '[VERIFY] Ship the importer',
      projectId: w.projectId,
      verifiesTaskId: subject.id,
    });

    assert.equal(check.verifiesTaskId, subject.id);
    assert.equal(check.completionCriterion, 'VERIFICATION');
    assert.equal(check.completionPolicy, TaskCompletionPolicy.MANUAL);
    assert.equal(check.completionCriterionOverrideReason, null);
    // The list projection carries it too, which is what makes "is this already being checked"
    // answerable without one GET per row — and it is in PUBLIC_ID_FIELDS, so the interceptor
    // spells it base62 on the way out (see task-verification-link.spec).
    const listed = (await tasks.list(w.ownerId)).find((row: any) => row.id === check.id) as any;
    assert.equal(listed.verifiesTaskId, subject.id);
    assert.equal(uuidToBase62(listed.verifiesTaskId), uuidToBase62(subject.id));
  });

  await t.test('every verifier verdict settles its carrier and a revocation reopens it', async () => {
    await emptyWorld(client);
    const w = await world(db, 'carrier');
    const tasks = tasksService(db);
    const subject = await tasks.create(w.ownerId, { title: 'subject', projectId: w.projectId });

    for (const verdict of [TaskVerdict.PASS, TaskVerdict.FAIL, TaskVerdict.INCONCLUSIVE]) {
      const check = await tasks.create(w.ownerId, {
        title: `check ${verdict}`,
        projectId: w.projectId,
        verifiesTaskId: subject.id,
      });
      assert.match(
        await message(() => tasks.update(w.ownerId, check.id, { status: TaskStatus.DONE })),
        /record PASS, FAIL or INCONCLUSIVE on this verification task/,
      );
      await tasks.update(w.ownerId, check.id, { verdict });
      assert.equal(await statusOf(db, check.id), TaskStatus.DONE);
      assert.match(
        await message(() => tasks.update(w.ownerId, check.id, { status: TaskStatus.CANCELLED })),
        /Revoke the verdict in the same request/,
      );
      assert.equal(await statusOf(db, check.id), TaskStatus.DONE,
        'the API must not accept a cancellation that the DB silently projects back to DONE');
      await tasks.update(w.ownerId, check.id, { verdict: null });
      const revoked = await db.task.findUniqueOrThrow({ where: { id: check.id } });
      assert.equal(revoked.verdict, null);
      assert.equal(revoked.status, TaskStatus.OPEN);
    }

    assert.match(await message(() => tasks.create(w.ownerId, {
      title: 'human check',
      projectId: w.projectId,
      verifiesTaskId: subject.id,
      completionCriterion: 'EVIDENCE_JUDGMENT',
    })), /must use VERIFICATION/);

    const rawCancellation = await tasks.create(w.ownerId, {
      title: 'raw cancellation check', projectId: w.projectId, verifiesTaskId: subject.id,
    });
    await tasks.update(w.ownerId, rawCancellation.id, { verdict: TaskVerdict.FAIL });
    await assert.rejects(
      db.task.update({
        where: { id: rawCancellation.id },
        data: { status: TaskStatus.CANCELLED },
      }),
      /VERIFIER_STATUS_DERIVED_FROM_VERDICT/,
      'the legacy verdict-reopen trigger cannot silently clear an unchanged verifier verdict',
    );
    await db.task.update({
      where: { id: rawCancellation.id },
      data: { status: TaskStatus.CANCELLED, verdict: null },
    });
    assert.deepEqual(await db.task.findUniqueOrThrow({
      where: { id: rawCancellation.id },
      select: { status: true, verdict: true },
    }), { status: TaskStatus.CANCELLED, verdict: null },
    'raw cancellation remains reachable when it revokes the verdict explicitly');

    const cancelled = await tasks.create(w.ownerId, {
      title: 'cancelled check', projectId: w.projectId, verifiesTaskId: subject.id,
    });
    await tasks.update(w.ownerId, cancelled.id, { status: TaskStatus.CANCELLED });
    assert.match(
      await message(() => tasks.update(w.ownerId, cancelled.id, { verdict: TaskVerdict.FAIL })),
      /cancelled or retired verification task cannot record a verdict/,
    );
    assert.equal(await statusOf(db, cancelled.id), TaskStatus.CANCELLED);

    const successor = await tasks.create(w.ownerId, {
      title: 'successor used by a retired verifier', projectId: w.projectId,
    });
    const retired = await db.task.create({
      data: {
        id: randomUUID(),
        ownerId: w.ownerId,
        title: 'retired verifier with a retained conclusion',
        creatorType: CreatorType.USER,
        creatorId: w.ownerId,
        projectId: w.projectId,
        verifiesTaskId: subject.id,
        completionCriterion: 'VERIFICATION',
        completionPolicy: 'MANUAL',
        status: TaskStatus.FAILED,
        verdict: TaskVerdict.FAIL,
        terminalReason: 'SUPERSEDED',
        supersededByTaskId: successor.id,
        supersededAt: new Date(),
      },
    });
    await tasks.update(w.ownerId, retired.id, {
      terminalReason: null,
      supersededByTaskId: null,
    });
    const restored = await db.task.findUniqueOrThrow({ where: { id: retired.id } });
    assert.equal(restored.terminalReason, null);
    assert.equal(restored.supersededByTaskId, null);
    assert.equal(restored.verdict, TaskVerdict.FAIL);
    assert.equal(restored.status, TaskStatus.DONE,
      'clearing the final retirement facts reactivates the retained verdict projection');

    const formerlyDone = await tasks.create(w.ownerId, {
      title: 'ordinary task completed before becoming a check', projectId: w.projectId,
    });
    await assert.rejects(
      db.task.update({ where: { id: formerlyDone.id }, data: { status: TaskStatus.DONE } }),
      /TASK_DONE_CANONICAL_FACT_REQUIRED/,
      'an ordinary task cannot become DONE without its declared completion fact',
    );
    await completeHumanTaskForPgTest(
      db,
      w.ownerId,
      formerlyDone.id,
      'ordinary task completed before becoming a check',
    );
    // The refusal below is keyed on the task HAVING completion evidence, so the fixture states
    // that fact rather than relying on the completion helper to leave one behind: since
    // 2026-09-02 the helper completes through VERIFICATION and writes no evidence of its own.
    await db.session.create({
      data: {
        id: randomUUID(),
        ownerId: w.ownerId,
        creatorId: w.ownerId,
        taskId: formerlyDone.id,
        title: 'evidence source',
        prompt: 'record what this task produced',
        status: 'AWAITING_INPUT',
        startsTaskWork: true,
      },
    }).then(async (session) => {
      // The envelope cites a row of this task's own; the fixture states that row too.
      await db.toolCall.create({
        data: {
          sessionId: session.id,
          name: 'Bash',
          toolUseId: 'toolu_formerly_done',
          input: { command: 'npm test', description: 'what this task recorded' },
          isError: false,
        },
      });
      await new TaskCompletionEvidenceService(db as unknown as PrismaService).submit(
        w.ownerId,
        formerlyDone.id,
        { type: 'USER', id: w.ownerId },
        {
          sourceSessionId: session.id,
          idempotencyKey: 'formerly-done-evidence',
          evidence: {
            claim: 'this task recorded what it produced',
            criterion: { key: 'pg-test', text: 'the task recorded what it produced' },
            checks: [{
              kind: 'TOOL_CALL',
              ref: 'toolu_formerly_done',
              command: 'npm test',
              succeeded: true,
            }],
            gaps: [],
          },
        },
      );
    });
    // Attaching a verifier derives VERIFICATION, which is a criterion change, so the reason is
    // sent to get PAST that door: the refusal under test is the one about evidence, and a request
    // stopped a step earlier would prove nothing about it.
    await assert.rejects(
      tasks.update(w.ownerId, formerlyDone.id, {
        verifiesTaskId: subject.id,
        completionCriterionOverrideReason: 'Reinterpreting this task as a check of another.',
      }),
      /already has completion evidence.*File a new verification task instead/,
      'a task that recorded completion evidence cannot be reinterpreted as a verifier',
    );
    const attached = await db.task.findUniqueOrThrow({ where: { id: formerlyDone.id } });
    assert.equal(attached.status, TaskStatus.DONE);
    assert.equal(attached.verifiesTaskId, null);
    assert.equal(attached.verdict, null);

    const evidenced = await tasks.create(w.ownerId, {
      title: 'ordinary task with an existing judgment lifecycle', projectId: w.projectId,
    });
    await db.taskCompletionEvidence.create({
      data: {
        taskId: evidenced.id,
        ownerId: w.ownerId,
        actorType: CreatorType.USER,
        actorId: w.ownerId,
        sourceSessionId: randomUUID(),
        criterionRevision: 'a'.repeat(64),
        criterion: { completionCriterion: 'EVIDENCE_JUDGMENT' },
        evidence: { artifact: 'already-reviewed.txt' },
        evidenceDigest: 'b'.repeat(64),
        revision: 1n,
      },
    });
    assert.match(
      await message(() => tasks.update(w.ownerId, evidenced.id, {
        verifiesTaskId: subject.id,
        completionCriterionOverrideReason: 'Reinterpreting this task as a check of another.',
      })),
      /already has completion evidence.*File a new verification task instead/,
    );
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: evidenced.id } })).verifiesTaskId,
      null, 'a refused conversion must leave the ordinary task and its request lifecycle intact');
  });

  await t.test('the four shapes a check may not take are refused with a reason', async () => {
    await emptyWorld(client);
    const w = await world(db, 'refuse');
    const tasks = tasksService(db);
    const subject = await tasks.create(w.ownerId, { title: 'subject', projectId: w.projectId });
    const check = await tasks.create(w.ownerId, {
      title: 'check',
      projectId: w.projectId,
      verifiesTaskId: subject.id,
    });
    const elsewhere = await tasks.create(w.ownerId, { title: 'elsewhere', projectId: w.otherProjectId });
    const stranger = await world(db, 'stranger');
    const theirs = await tasks.create(stranger.ownerId, { title: 'theirs', projectId: stranger.projectId });

    assert.match(
      await message(() => tasks.update(w.ownerId, check.id, { verifiesTaskId: check.id })),
      /cannot verify itself/,
    );
    assert.match(
      await message(() =>
        tasks.create(w.ownerId, { title: 'x', projectId: w.projectId, verifiesTaskId: check.id }),
      ),
      /itself a verification/,
    );
    assert.match(
      await message(() =>
        tasks.create(w.ownerId, { title: 'x', projectId: w.projectId, verifiesTaskId: elsewhere.id }),
      ),
      /same project as the task it verifies/,
    );
    assert.match(
      await message(() =>
        tasks.create(w.ownerId, { title: 'x', projectId: w.projectId, verifiesTaskId: theirs.id }),
      ),
      /verified task not found/,
    );
    // And the subject cannot be moved out from under its checks either — the same rule, from the
    // side that would otherwise break it silently.
    assert.match(
      await message(() => tasks.update(w.ownerId, subject.id, { projectId: w.otherProjectId })),
      /verification\(s\) that would be left in a different project/,
    );
  });

  await t.test('a concluded check cannot be re-pointed at a different subject', async () => {
    await emptyWorld(client);
    const w = await world(db, 'repoint');
    const tasks = tasksService(db);
    const first = await tasks.create(w.ownerId, { title: 'first', projectId: w.projectId });
    const second = await tasks.create(w.ownerId, { title: 'second', projectId: w.projectId });
    const check = await tasks.create(w.ownerId, {
      title: 'check',
      projectId: w.projectId,
      verifiesTaskId: first.id,
    });

    // Before it concludes, re-pointing is an ordinary correction.
    await tasks.update(w.ownerId, check.id, { verifiesTaskId: second.id });
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: check.id } })).verifiesTaskId, second.id);

    await tasks.update(w.ownerId, check.id, { verdict: TaskVerdict.PASS });
    assert.match(
      await message(() => tasks.update(w.ownerId, check.id, { verifiesTaskId: first.id })),
      /already concluded — its subject can no longer be changed/,
    );
    // Its own verdict is still editable; what is frozen is what the verdict is ABOUT.
    await tasks.update(w.ownerId, check.id, { verdict: TaskVerdict.FAIL });
    const after = await db.task.findUniqueOrThrow({ where: { id: check.id } });
    assert.equal(after.verifiesTaskId, second.id);
    assert.equal(after.verdict, TaskVerdict.FAIL);
    assert.ok(after.verdictRevision > 1n, 'a second conclusion advances the revision (V7)');
  });

  await t.test('a verdict is refused on a task that verifies nothing, and reachable in one call with the link', async () => {
    await emptyWorld(client);
    const w = await world(db, 'verdict');
    const tasks = tasksService(db);
    const subject = await tasks.create(w.ownerId, { title: 'subject', projectId: w.projectId });
    const plain = await tasks.create(w.ownerId, { title: 'plain', projectId: w.projectId });

    assert.match(
      await message(() => tasks.update(w.ownerId, plain.id, { verdict: TaskVerdict.PASS })),
      /does not verify anything/,
    );
    // Pointing it and concluding in the same write is legal: the guard reads the subject this
    // task will have AFTER the write, not the one it had before it.
    await tasks.update(w.ownerId, plain.id, {
      verifiesTaskId: subject.id,
      verdict: TaskVerdict.PASS,
      completionCriterionOverrideReason:
        'This task now exists to check another, so its verdict is what settles it.',
    });
    const after = await db.task.findUniqueOrThrow({ where: { id: plain.id } });
    assert.equal(after.verdict, TaskVerdict.PASS);
    assert.equal(after.verifiesTaskId, subject.id);
  });

  await t.test('a verification cannot be concluded from the session that ran its subject', async () => {
    await emptyWorld(client);
    const w = await world(db, 'independent');
    const tasks = tasksService(db);
    const subject = await tasks.create(w.ownerId, { title: 'subject', projectId: w.projectId });
    const check = await tasks.create(w.ownerId, {
      title: 'check',
      projectId: w.projectId,
      verifiesTaskId: subject.id,
    });
    // The run that did the WORK — finished, successful, and exactly the one whose conclusion
    // about its own task is worth nothing.
    const devRun = await db.session.create({
      data: {
        ownerId: w.ownerId,
        creatorId: w.ownerId,
        workspaceId: w.workspaceId,
        taskId: subject.id,
        title: 'dev run',
        prompt: 'do the work',
        status: RunStatus.SUCCEEDED,
      },
    });
    const ownRun = await db.session.create({
      data: {
        ownerId: w.ownerId,
        creatorId: w.ownerId,
        workspaceId: w.workspaceId,
        taskId: check.id,
        title: 'verification run',
        prompt: 'check the work',
        status: RunStatus.RUNNING,
      },
    });

    assert.match(
      await message(() =>
        tasks.update(w.ownerId, check.id, { verdict: TaskVerdict.PASS }, devRun.id),
      ),
      /cannot be concluded from the session that ran the task it verifies/,
    );
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: check.id } })).verdict,
      null,
      'the refusal must not have written the verdict',
    );
    // The verification's OWN run is exactly what is supposed to conclude it.
    await tasks.update(w.ownerId, check.id, { verdict: TaskVerdict.PASS }, ownRun.id);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: check.id } })).verdict, TaskVerdict.PASS);
  });

  // ---------------------------------------------------------------------------------------
  // The phase fixture — the thing this unit exists for
  // ---------------------------------------------------------------------------------------

  await t.test('a real phase completes itself from its independent check, with no status write', async () => {
    await emptyWorld(client);
    const w = await world(db, 'phase');
    const tasks = tasksService(db);

    // Filed the way a plan is actually filed: one atomic batch, the phase and everything under it
    // wired by ref because none of their ids exist yet.
    const created = await tasks.createMany(w.ownerId, {
      tasks: [
        {
          title: 'Phase 25B',
          ref: 'phase',
          projectId: w.projectId,
          completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
        },
        {
          title: 'Implement the door',
          ref: 'impl',
          projectId: w.projectId,
          parentRef: 'phase',
          completionCriterion: 'VERIFICATION',
          completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
        },
        {
          title: 'Wire the CLI',
          ref: 'cli',
          projectId: w.projectId,
          parentRef: 'phase',
          completionCriterion: 'VERIFICATION',
          completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
        },
        { title: '[VERIFY] Phase 25B', ref: 'check', projectId: w.projectId, verifiesRef: 'phase' },
      ],
    } as any);
    const id = Object.fromEntries(created.map((row: any) => [row.ref, row.id])) as Record<string, string>;

    assert.equal(await statusOf(db, id.phase), TaskStatus.OPEN);

    // A person cannot short-circuit it. This is the refusal that makes the completion below mean
    // something: the phase's DONE is not available to whoever felt like writing it.
    assert.match(
      await message(() => tasks.update(w.ownerId, id.phase, { status: TaskStatus.DONE })),
      /derived from the declared VERIFICATION criterion.*independent verification task with verdict PASS/,
    );

    const implVerifierId = await passViaIndependentVerifier(
      tasks, w.ownerId, w.projectId, id.impl, 'Implement the door',
    );
    assert.equal(await statusOf(db, id.phase), TaskStatus.OPEN, 'one subtask is not all of them');

    await passViaIndependentVerifier(tasks, w.ownerId, w.projectId, id.cli, 'Wire the CLI');
    assert.equal(
      await statusOf(db, id.phase),
      TaskStatus.OPEN,
      'children settled, but VERIFICATION_PASSED still wants the check',
    );

    // INCONCLUSIVE is not a pass, and must not read as one.
    await tasks.update(w.ownerId, id.check, {
      verdict: TaskVerdict.INCONCLUSIVE,
    });
    assert.equal(await statusOf(db, id.phase), TaskStatus.OPEN, 'INCONCLUSIVE must not complete a phase');

    published.length = 0;
    await tasks.update(w.ownerId, id.check, { verdict: TaskVerdict.PASS });
    assert.equal(await statusOf(db, id.phase), TaskStatus.DONE, 'the policy completed the phase');
    assert.ok(
      published.some((event) => event.taskId === id.phase),
      'a status nobody wrote still has to be announced',
    );

    // AG3, both ways round. A revoked pass is not an undo — it is a check that no longer
    // concludes anything, and a phase standing on it goes back to OPEN.
    await tasks.update(w.ownerId, id.check, { verdict: null });
    assert.equal(await statusOf(db, id.phase), TaskStatus.OPEN, 'revoking the pass reopens the phase');

    await tasks.update(w.ownerId, id.check, { verdict: TaskVerdict.PASS });
    assert.equal(await statusOf(db, id.phase), TaskStatus.DONE);

    await tasks.update(w.ownerId, id.check, { verdict: TaskVerdict.FAIL });
    assert.equal(await statusOf(db, id.phase), TaskStatus.OPEN, 'a FAIL reopens the phase');

    await tasks.update(w.ownerId, id.check, { verdict: TaskVerdict.PASS });
    await revokeVerifierPass(tasks, w.ownerId, implVerifierId);
    assert.equal(
      await statusOf(db, id.phase),
      TaskStatus.DONE,
      'VERIFICATION is one peer criterion, not a hidden conjunction with child status',
    );

    await tasks.update(w.ownerId, id.impl, { status: TaskStatus.FAILED });
    assert.equal(
      await statusOf(db, id.phase),
      TaskStatus.DONE,
      'a failed child does not erase the phase\'s independent PASS fact',
    );

    await tasks.update(w.ownerId, implVerifierId, { verdict: TaskVerdict.PASS });
    assert.equal(await statusOf(db, id.phase), TaskStatus.DONE);
  });

  await t.test('a phase is reopened by work that ARRIVES under it, not only by work that stops', async () => {
    await emptyWorld(client);
    const w = await world(db, 'arrive');
    const tasks = tasksService(db);
    const phase = await tasks.create(w.ownerId, {
      title: 'phase',
      projectId: w.projectId,
      completionPolicy: TaskCompletionPolicy.ALL_CHILDREN_DONE,
    });
    const first = await tasks.create(w.ownerId, {
      title: 'first',
      projectId: w.projectId,
      parentTaskId: phase.id,
      completionCriterion: 'VERIFICATION',
      completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
    });
    await passViaIndependentVerifier(tasks, w.ownerId, w.projectId, first.id, 'first');
    assert.equal(await statusOf(db, phase.id), TaskStatus.DONE);

    const late = await tasks.create(w.ownerId, {
      title: 'one more thing',
      projectId: w.projectId,
      parentTaskId: phase.id,
    });
    assert.equal(
      await statusOf(db, first.id),
      TaskStatus.DONE,
      'discovering a child from its parent also loads the verifier facts behind that child',
    );
    assert.equal(await statusOf(db, phase.id), TaskStatus.OPEN, 'a new subtask reopens its parent');

    // And a check arriving at a VERIFICATION_PASSED parent does the same.
    await tasks.update(w.ownerId, late.id, { status: TaskStatus.CANCELLED });
    assert.equal(await statusOf(db, phase.id), TaskStatus.DONE, 'CANCELLED settles, unlike FAILED');
    await tasks.update(w.ownerId, phase.id, {
      completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
      completionCriterionOverrideReason:
        'The phase settles on an independent check from here, not on its own evidence.',
    });
    assert.equal(await statusOf(db, phase.id), TaskStatus.OPEN, 'no check yet, so nothing to stand on');

    // Deleting the last outstanding subtask is the third input, and the one that COMPLETES.
    await tasks.update(w.ownerId, phase.id, {
      completionPolicy: TaskCompletionPolicy.ALL_CHILDREN_DONE,
      completionCriterionOverrideReason: 'The phase goes back to settling on its children.',
    });
    const blocker = await tasks.create(w.ownerId, {
      title: 'blocker',
      projectId: w.projectId,
      parentTaskId: phase.id,
    });
    assert.equal(await statusOf(db, phase.id), TaskStatus.OPEN);
    await tasks.remove(w.ownerId, blocker.id);
    assert.equal(await statusOf(db, phase.id), TaskStatus.DONE, 'what is left of the children decides');
  });

  await t.test('a childless aggregate policy and a MANUAL parent do not manufacture completion', async () => {
    await emptyWorld(client);
    const w = await world(db, 'legacy');
    const tasks = tasksService(db);

    // AG4: a policy on a childless task is inert, and stays inert.
    const leaf = await tasks.create(w.ownerId, {
      title: 'leaf',
      projectId: w.projectId,
      completionPolicy: TaskCompletionPolicy.ALL_CHILDREN_DONE,
      completionCriterion: 'EVIDENCE_JUDGMENT',
    });
    assert.equal(await statusOf(db, leaf.id), TaskStatus.OPEN);
    // ...and the inert aggregate policy does not create a back door around its own criterion.
    assert.match(
      await message(() => tasks.update(w.ownerId, leaf.id, { status: TaskStatus.DONE })),
      /derived from the declared EVIDENCE_JUDGMENT criterion/,
    );
    assert.equal(await statusOf(db, leaf.id), TaskStatus.OPEN);

    // MANUAL still means children decide nothing. The parent's own declared criterion remains the
    // only way to complete it; it cannot borrow either a child's PASS or a direct status write.
    const parent = await tasks.create(w.ownerId, {
      title: 'manual',
      projectId: w.projectId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
    });
    const child = await tasks.create(w.ownerId, {
      title: 'child',
      projectId: w.projectId,
      parentTaskId: parent.id,
      completionCriterion: 'VERIFICATION',
      completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
    });
    const childVerifierId = await passViaIndependentVerifier(
      tasks, w.ownerId, w.projectId, child.id, 'child',
    );
    assert.equal(await statusOf(db, parent.id), TaskStatus.OPEN, 'MANUAL never completes itself');
    assert.match(
      await message(() => tasks.update(w.ownerId, parent.id, { status: TaskStatus.DONE })),
      /derived from the declared EVIDENCE_JUDGMENT criterion/,
    );
    await revokeVerifierPass(tasks, w.ownerId, childVerifierId);
    assert.equal(await statusOf(db, parent.id), TaskStatus.OPEN, 'a child reopening is still inert');
  });

  await t.test('a whole chain settles in one pass, bottom up', async () => {
    await emptyWorld(client);
    const w = await world(db, 'multilevel');
    const tasks = tasksService(db);
    const grand = await tasks.create(w.ownerId, {
      title: 'grandparent',
      projectId: w.projectId,
      completionPolicy: TaskCompletionPolicy.ALL_CHILDREN_DONE,
    });
    const mid = await tasks.create(w.ownerId, {
      title: 'parent',
      projectId: w.projectId,
      parentTaskId: grand.id,
      completionPolicy: TaskCompletionPolicy.ALL_CHILDREN_DONE,
    });
    const leaf = await tasks.create(w.ownerId, {
      title: 'leaf',
      projectId: w.projectId,
      parentTaskId: mid.id,
      completionCriterion: 'VERIFICATION',
      completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
    });

    const leafVerifierId = await passViaIndependentVerifier(
      tasks, w.ownerId, w.projectId, leaf.id, 'leaf',
    );
    // One write, two levels: a recomputation that only moved one level per event would need a
    // second trigger that nothing here produces.
    assert.equal(await statusOf(db, mid.id), TaskStatus.DONE);
    assert.equal(await statusOf(db, grand.id), TaskStatus.DONE);

    await revokeVerifierPass(tasks, w.ownerId, leafVerifierId);
    assert.equal(await statusOf(db, mid.id), TaskStatus.OPEN);
    assert.equal(await statusOf(db, grand.id), TaskStatus.OPEN);
  });

  await t.test('duplicated, out-of-order and concurrent recomputation land on one answer', async () => {
    await emptyWorld(client);
    const w = await world(db, 'converge');
    const tasks = tasksService(db);
    const phase = await tasks.create(w.ownerId, {
      title: 'phase',
      projectId: w.projectId,
      completionPolicy: TaskCompletionPolicy.ALL_CHILDREN_DONE,
    });
    const children = [];
    for (const title of ['a', 'b', 'c']) {
      children.push(
        await tasks.create(w.ownerId, {
          title,
          projectId: w.projectId,
          parentTaskId: phase.id,
          completionCriterion: 'VERIFICATION',
          completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
        }),
      );
    }

    // Three completions at once. The CAS is the whole of the concurrency control, so the losers
    // write nothing rather than fighting over the parent.
    await Promise.all(
      children.map((child) => passViaIndependentVerifier(
        tasks, w.ownerId, w.projectId, child.id, child.title,
      )),
    );
    assert.deepEqual(
      await Promise.all(children.map((child) => statusOf(db, child.id))),
      children.map(() => TaskStatus.DONE),
      'every concurrent PASS remains visible when the parent closure is recomputed',
    );
    assert.equal(await statusOf(db, phase.id), TaskStatus.DONE);

    // The same conclusion delivered again, from a service that has just started — the shape of a
    // process restart, and of a redelivered event. A recomputation has no accumulator to
    // double-count and no permanent key to collide with, so it simply agrees.
    const restarted = tasksService(db);
    published.length = 0;
    await (restarted as any).recomputeAggregates(w.ownerId, [phase.id]);
    await (restarted as any).recomputeAggregates(w.ownerId, [children[0].id]);
    assert.equal(await statusOf(db, phase.id), TaskStatus.DONE);
    assert.equal(published.length, 0, 'an aggregation that changed nothing is not an event');
  });

  await t.test('a task verdict does not change the project’s stated criteria', async () => {
    await emptyWorld(client);
    const w = await world(db, 'acceptance');
    const tasks = tasksService(db);
    const prisma = db as unknown as PrismaService;
    const acceptance = new ProjectAcceptanceService(prisma);
    const projects = new ProjectsService(prisma, acceptance);

    const phase = await tasks.create(w.ownerId, {
      title: 'phase',
      projectId: w.projectId,
      completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
    });
    const work = await tasks.create(w.ownerId, {
      title: 'work',
      projectId: w.projectId,
      parentTaskId: phase.id,
      completionCriterion: 'VERIFICATION',
      completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
    });
    await passViaIndependentVerifier(tasks, w.ownerId, w.projectId, work.id, 'work');
    const check = await tasks.create(w.ownerId, {
      title: '[VERIFY] phase',
      projectId: w.projectId,
      verifiesTaskId: phase.id,
    });

    // N4: task verdicts are evidence for task execution, not project acceptance criteria. Neither
    // filing nor concluding this check may redefine what the project states it is for. Since 0229
    // the criteria are the whole of that statement, so the assertion is that the DEFINITION rows
    // are byte-identical either side of the verdict.
    const criteriaOf = async () => prisma.projectAcceptanceCriterionDefinition.findMany({
      where: { projectId: w.projectId },
      orderBy: { ordinal: 'asc' },
    });
    const beforeVerdict = JSON.stringify(await criteriaOf());
    await tasks.update(w.ownerId, check.id, { verdict: TaskVerdict.PASS });
    const afterVerdict = JSON.stringify(await criteriaOf());
    assert.equal(beforeVerdict, afterVerdict, 'task state must not rewrite the stated criteria');
  });

  await t.test('a check is counted for the phase it points at, not for the one it sits under', async () => {
    await emptyWorld(client);
    const w = await world(db, 'shape');
    const tasks = tasksService(db);
    const phase = await tasks.create(w.ownerId, {
      title: 'phase',
      projectId: w.projectId,
      completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
    });
    const work = await tasks.create(w.ownerId, {
      title: 'work',
      projectId: w.projectId,
      parentTaskId: phase.id,
      completionCriterion: 'VERIFICATION',
      completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
    });
    // A check of the SUBTASK, not of the phase. VERIFICATION_PASSED on the phase must not read
    // this as its own evidence — it is a fact about `work`.
    const checkOfWork = await tasks.create(w.ownerId, {
      title: '[VERIFY] work',
      projectId: w.projectId,
      verifiesTaskId: work.id,
    });
    await tasks.update(w.ownerId, checkOfWork.id, { verdict: TaskVerdict.PASS });
    assert.equal(
      await statusOf(db, phase.id),
      TaskStatus.OPEN,
      'a pass about a subtask is not a pass about the phase',
    );

    const checkOfPhase = await tasks.create(w.ownerId, {
      title: '[VERIFY] phase',
      projectId: w.projectId,
      verifiesTaskId: phase.id,
    });
    await tasks.update(w.ownerId, checkOfPhase.id, { verdict: TaskVerdict.PASS });
    assert.equal(await statusOf(db, phase.id), TaskStatus.DONE);
  });
});
