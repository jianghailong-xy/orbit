import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PushService } from '../push/push.service';
import { MergeReceiptService } from '../sessions/merge-receipt.service';
import { TasksService } from '../tasks/tasks.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';
import { criteriaFromDefinitions } from './project-acceptance';
import { ProjectAcceptanceService } from './project-acceptance.service';
import { storeDerivedProjectStatus } from './project-done-derived';
import { ProjectsService } from './projects.service';

const url = process.env.COORDINATOR_PG_URL;

test('only a committed derived OPEN → DONE transition pushes the owner', {
  skip: !url, timeout: 300_000,
}, async (t) => {
  assertCoordinatorPgUrlIsIsolated(url!);
  const sql = new Client({ connectionString: url });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma = prismaClientFor(url!);
  t.after(async () => { await prisma.$disconnect(); await sql.end(); });
  const db = prisma as unknown as PrismaService;
  const acceptance = new ProjectAcceptanceService(db);
  const projects = new ProjectsService(db, acceptance);
  const tasks = new TasksService(db, {} as never, {
    publishTaskChanged() {}, publishForUser() {},
  } as never);
  const receipts = new MergeReceiptService(db);
  const ownerId = randomUUID();
  await prisma.user.create({ data: {
    id: ownerId, email: `derived-push-${ownerId}@example.invalid`, name: 'Owner', passwordHash: 'x',
  } });

  // Stop before the projection edge: confirmation precedes landing, and this receipt fixture
  // has no completion router. The explicit store calls below therefore own the transition.
  async function readyProject(title: string) {
    const project = await prisma.project.create({ data: { ownerId, title } });
    const [criterion] = criteriaFromDefinitions((await projects.update(ownerId, project.id, {
      acceptanceCriteriaItems: [{ text: 'The change is delivered', verificationMethod: 'HUMAN' }],
    } as never)).acceptanceCriteriaItems);
    assert.ok(criterion);
    const task = await tasks.create(ownerId, {
      title: 'Deliver the change', projectId: project.id, criterionKey: criterion.key,
      completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    } as never);
    await sql.query('UPDATE task SET status = \'DONE\' WHERE id = $1::uuid', [task.id]);
    const session = await prisma.session.create({ data: {
      ownerId, creatorId: ownerId, taskId: task.id, title: 'Delivery', prompt: 'Deliver',
      status: 'SUCCEEDED', branch: 'orbit/derived-push', isolationStatus: 'worktree',
    } });
    const digest = (await acceptance.standardSetConfirmation(ownerId, project.id)).currentVersion.digest;
    await acceptance.confirmStandardSet(ownerId, project.id, { criteriaDigest: digest });
    await receipts.record(ownerId, session.id, {
      result: 'MERGED', sourceSha: '1'.repeat(40), targetBranch: 'main',
      targetShaBefore: '2'.repeat(40), targetShaAfter: '3'.repeat(40),
    }, 'AGENT');
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status, 'OPEN');
    return { ...project, digest };
  }

  // Exercise the production payload and transport boundary, without reaching real devices.
  const push = new PushService(db, { get: () => undefined } as never);
  const sent: Array<{ ownerId: string; payload: {
    kind: string; projectID: string; aps: { alert: { title: string; body: string } };
  } }> = [];
  const transport = push as any;
  Object.defineProperty(transport, 'enabled', { get: () => true });
  let recipient: string;
  transport.channels = async (id: string) => { recipient = id; return { tokens: [] }; };
  transport.deliver = async (_tokens: unknown, body: string) => {
    const payload = JSON.parse(body);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: payload.projectID } })).status, 'DONE',
      'the push observes the committed projection');
    sent.push({ ownerId: recipient, payload });
  };
  const project = await readyProject('Session Recap');
  assert.equal((await storeDerivedProjectStatus(db, ownerId, project.id, { push })).done, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.ownerId, ownerId);
  assert.deepEqual(sent[0]!.payload.aps.alert, {
    title: 'Session Recap is done',
    body: 'Orbit recorded it: all 1 criteria met and on main.',
  });
  assert.equal(sent[0]!.payload.projectID, project.id);
  assert.equal(sent[0]!.payload.kind, 'project-done');
  assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).doneBy, 'DERIVED');
  await storeDerivedProjectStatus(db, ownerId, project.id, { push });
  assert.equal(sent.length, 1, 're-derivation writes nothing and sends nothing');

  const ownerProject = await readyProject('Owner recorded');
  const ownerAcceptance = new ProjectAcceptanceService(db, undefined, push);
  await ownerAcceptance.recordProjectDone(ownerId, ownerProject.id, {
    criteriaDigest: ownerProject.digest, acceptedGaps: [],
  });
  await storeDerivedProjectStatus(db, ownerId, ownerProject.id, { push });
  assert.equal(sent.length, 1, 'an owner record is never announced back to its owner');

  // Reopening the work projects DONE → OPEN, without announcing completion again.
  await sql.query("UPDATE task SET status = 'OPEN' WHERE project_id = $1::uuid", [project.id]);
  assert.equal((await storeDerivedProjectStatus(db, ownerId, project.id, { push })).done, false);
  assert.equal(sent.length, 1);

  const failedPush = await readyProject('Push failure');
  await storeDerivedProjectStatus(db, ownerId, failedPush.id, {
    push: { notifyProjectDone: async () => {
      assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: failedPush.id } })).status, 'DONE');
      throw new Error('Transport unavailable');
    } },
  });
  assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: failedPush.id } })).status, 'DONE');
});
