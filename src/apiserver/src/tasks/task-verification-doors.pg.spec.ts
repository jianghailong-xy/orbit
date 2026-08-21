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
import { ProjectsService } from '../projects/projects.service';
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
    publishForUser: (ownerId: string, _type: unknown, taskId: string) =>
      published.push({ ownerId, taskId }),
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
  }
  return { ownerId, projectId, otherProjectId, workspaceId };
}

async function emptyWorld(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  published.length = 0;
  await client.query(`
    TRUNCATE "project_event", "project_decision", "project_action", "project_runtime",
             "task", "session", "workspace", "runner", "project", "user"
    RESTART IDENTITY CASCADE
  `);
}

async function statusOf(db: PrismaClient, id: string): Promise<string> {
  const row = await db.task.findUniqueOrThrow({ where: { id }, select: { status: true } });
  return row.status;
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
    // The list projection carries it too, which is what makes "is this already being checked"
    // answerable without one GET per row — and it is in PUBLIC_ID_FIELDS, so the interceptor
    // spells it base62 on the way out (see task-verification-link.spec).
    const listed = (await tasks.list(w.ownerId)).find((row: any) => row.id === check.id) as any;
    assert.equal(listed.verifiesTaskId, subject.id);
    assert.equal(uuidToBase62(listed.verifiesTaskId), uuidToBase62(subject.id));
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

    await tasks.update(w.ownerId, check.id, { status: TaskStatus.DONE, verdict: TaskVerdict.PASS });
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
      status: TaskStatus.DONE,
      verdict: TaskVerdict.PASS,
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
        tasks.update(w.ownerId, check.id, { status: TaskStatus.DONE, verdict: TaskVerdict.PASS }, devRun.id),
      ),
      /cannot be concluded from the session that ran the task it verifies/,
    );
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: check.id } })).verdict,
      null,
      'the refusal must not have written the verdict',
    );
    // The verification's OWN run is exactly what is supposed to conclude it.
    await tasks.update(w.ownerId, check.id, { status: TaskStatus.DONE, verdict: TaskVerdict.PASS }, ownRun.id);
    assert.equal((await db.task.findUniqueOrThrow({ where: { id: check.id } })).verdict, TaskVerdict.PASS);
  });

  // ---------------------------------------------------------------------------------------
  // The phase fixture — the thing this unit exists for
  // ---------------------------------------------------------------------------------------

  await t.test('a real phase completes itself from its subtasks and its check, with no status write', async () => {
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
        { title: 'Implement the door', ref: 'impl', projectId: w.projectId, parentRef: 'phase' },
        { title: 'Wire the CLI', ref: 'cli', projectId: w.projectId, parentRef: 'phase' },
        { title: '[VERIFY] Phase 25B', ref: 'check', projectId: w.projectId, verifiesRef: 'phase' },
      ],
    } as any);
    const id = Object.fromEntries(created.map((row: any) => [row.ref, row.id])) as Record<string, string>;

    assert.equal(await statusOf(db, id.phase), TaskStatus.OPEN);

    // A person cannot short-circuit it. This is the refusal that makes the completion below mean
    // something: the phase's DONE is not available to whoever felt like writing it.
    assert.match(
      await message(() => tasks.update(w.ownerId, id.phase, { status: TaskStatus.DONE })),
      /completes by VERIFICATION_PASSED, not by a status write/,
    );

    await tasks.update(w.ownerId, id.impl, { status: TaskStatus.DONE });
    assert.equal(await statusOf(db, id.phase), TaskStatus.OPEN, 'one subtask is not all of them');

    await tasks.update(w.ownerId, id.cli, { status: TaskStatus.DONE });
    assert.equal(
      await statusOf(db, id.phase),
      TaskStatus.OPEN,
      'children settled, but VERIFICATION_PASSED still wants the check',
    );

    // INCONCLUSIVE is not a pass, and must not read as one.
    await tasks.update(w.ownerId, id.check, {
      status: TaskStatus.DONE,
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
    await tasks.update(w.ownerId, id.impl, { status: TaskStatus.OPEN });
    assert.equal(await statusOf(db, id.phase), TaskStatus.OPEN, 'a reopened subtask reopens the phase');

    await tasks.update(w.ownerId, id.impl, { status: TaskStatus.FAILED });
    assert.equal(
      await statusOf(db, id.phase),
      TaskStatus.OPEN,
      'FAILED has stopped, which is not the same as finished',
    );

    await tasks.update(w.ownerId, id.impl, { status: TaskStatus.DONE });
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
    });
    await tasks.update(w.ownerId, first.id, { status: TaskStatus.DONE });
    assert.equal(await statusOf(db, phase.id), TaskStatus.DONE);

    const late = await tasks.create(w.ownerId, {
      title: 'one more thing',
      projectId: w.projectId,
      parentTaskId: phase.id,
    });
    assert.equal(await statusOf(db, phase.id), TaskStatus.OPEN, 'a new subtask reopens its parent');

    // And a check arriving at a VERIFICATION_PASSED parent does the same.
    await tasks.update(w.ownerId, late.id, { status: TaskStatus.CANCELLED });
    assert.equal(await statusOf(db, phase.id), TaskStatus.DONE, 'CANCELLED settles, unlike FAILED');
    await tasks.update(w.ownerId, phase.id, {
      completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
    });
    assert.equal(await statusOf(db, phase.id), TaskStatus.OPEN, 'no check yet, so nothing to stand on');

    // Deleting the last outstanding subtask is the third input, and the one that COMPLETES.
    await tasks.update(w.ownerId, phase.id, { completionPolicy: TaskCompletionPolicy.ALL_CHILDREN_DONE });
    const blocker = await tasks.create(w.ownerId, {
      title: 'blocker',
      projectId: w.projectId,
      parentTaskId: phase.id,
    });
    assert.equal(await statusOf(db, phase.id), TaskStatus.OPEN);
    await tasks.remove(w.ownerId, blocker.id);
    assert.equal(await statusOf(db, phase.id), TaskStatus.DONE, 'what is left of the children decides');
  });

  await t.test('a leaf task and a MANUAL parent are untouched by any of this', async () => {
    await emptyWorld(client);
    const w = await world(db, 'legacy');
    const tasks = tasksService(db);

    // AG4: a policy on a childless task is inert, and stays inert.
    const leaf = await tasks.create(w.ownerId, {
      title: 'leaf',
      projectId: w.projectId,
      completionPolicy: TaskCompletionPolicy.ALL_CHILDREN_DONE,
    });
    assert.equal(await statusOf(db, leaf.id), TaskStatus.OPEN);
    // ...and a status write is not refused on it either, because the policy is answering nothing.
    await tasks.update(w.ownerId, leaf.id, { status: TaskStatus.DONE });
    assert.equal(await statusOf(db, leaf.id), TaskStatus.DONE);

    // MANUAL is what every task created before migration 0123 has, and it must keep behaving
    // exactly as it always did: children decide nothing, a status write decides everything.
    const parent = await tasks.create(w.ownerId, { title: 'manual', projectId: w.projectId });
    const child = await tasks.create(w.ownerId, {
      title: 'child',
      projectId: w.projectId,
      parentTaskId: parent.id,
    });
    await tasks.update(w.ownerId, child.id, { status: TaskStatus.DONE });
    assert.equal(await statusOf(db, parent.id), TaskStatus.OPEN, 'MANUAL never completes itself');
    await tasks.update(w.ownerId, parent.id, { status: TaskStatus.DONE });
    assert.equal(await statusOf(db, parent.id), TaskStatus.DONE, 'and MANUAL is never refused');
    await tasks.update(w.ownerId, child.id, { status: TaskStatus.OPEN });
    assert.equal(await statusOf(db, parent.id), TaskStatus.DONE, 'nor reopened behind the writer’s back');
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
    });

    await tasks.update(w.ownerId, leaf.id, { status: TaskStatus.DONE });
    // One write, two levels: a recomputation that only moved one level per event would need a
    // second trigger that nothing here produces.
    assert.equal(await statusOf(db, mid.id), TaskStatus.DONE);
    assert.equal(await statusOf(db, grand.id), TaskStatus.DONE);

    await tasks.update(w.ownerId, leaf.id, { status: TaskStatus.IN_PROGRESS });
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
        await tasks.create(w.ownerId, { title, projectId: w.projectId, parentTaskId: phase.id }),
      );
    }

    // Three completions at once. The CAS is the whole of the concurrency control, so the losers
    // write nothing rather than fighting over the parent.
    await Promise.all(
      children.map((child) => tasks.update(w.ownerId, child.id, { status: TaskStatus.DONE })),
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

  await t.test('a verdict written through the task door is what the project reads back', async () => {
    await emptyWorld(client);
    const w = await world(db, 'acceptance');
    const tasks = tasksService(db);
    const prisma = db as unknown as PrismaService;
    const acceptance = new ProjectAcceptanceService(prisma);
    const projects = new ProjectsService(prisma, {} as any, acceptance);

    const phase = await tasks.create(w.ownerId, {
      title: 'phase',
      projectId: w.projectId,
      completionPolicy: TaskCompletionPolicy.VERIFICATION_PASSED,
    });
    const work = await tasks.create(w.ownerId, {
      title: 'work',
      projectId: w.projectId,
      parentTaskId: phase.id,
    });
    await tasks.update(w.ownerId, work.id, { status: TaskStatus.DONE });
    const check = await tasks.create(w.ownerId, {
      title: '[VERIFY] phase',
      projectId: w.projectId,
      verifiesTaskId: phase.id,
    });

    // AE1's acceptanceDigest over the four projections. Filing the check already moved it — the
    // verdict tuple is one of them — and concluding moves it again, which is what makes an older
    // acceptance run stop matching the world it judged (AE4).
    const beforeVerdict = await acceptance.digest(prisma, w.projectId);
    await tasks.update(w.ownerId, check.id, { status: TaskStatus.DONE, verdict: TaskVerdict.PASS });
    const afterVerdict = await acceptance.digest(prisma, w.projectId);
    assert.notEqual(beforeVerdict, afterVerdict, 'a verdict is an acceptance fact, so it moves the digest');

    const read = await projects.verifications(w.ownerId, w.projectId);
    const one = read.verifications.find((row) => row.verifierTaskId === check.id);
    assert.ok(one, 'the check has to appear in the project verification report at all');
    assert.equal(one.verdict, TaskVerdict.PASS);
    assert.equal(one.verdictRevision, '1', 'the first conclusion is revision 1 (§13.2 V7)');
    assert.equal(one.subjectTaskId, phase.id, 'the report names what it concluded about');
    assert.equal(one.subjectStatus, TaskStatus.DONE, 'and the phase that pass completed');
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
    });
    // A check of the SUBTASK, not of the phase. VERIFICATION_PASSED on the phase must not read
    // this as its own evidence — it is a fact about `work`.
    const checkOfWork = await tasks.create(w.ownerId, {
      title: '[VERIFY] work',
      projectId: w.projectId,
      verifiesTaskId: work.id,
    });
    await tasks.update(w.ownerId, work.id, { status: TaskStatus.DONE });
    await tasks.update(w.ownerId, checkOfWork.id, { status: TaskStatus.DONE, verdict: TaskVerdict.PASS });
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
    await tasks.update(w.ownerId, checkOfPhase.id, { status: TaskStatus.DONE, verdict: TaskVerdict.PASS });
    assert.equal(await statusOf(db, phase.id), TaskStatus.DONE);
  });
});
