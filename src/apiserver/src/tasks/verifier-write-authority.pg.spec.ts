/**
 * Who may write the verification relation (docs/orbit-files-design.md §2.7), held against the production apiserver —
 * `build/main.js` and every guard and pipe in front of the routes — over a real PostgreSQL that `scripts/run-pg-spec.sh`
 * migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/verifier-write-authority.pg.spec.ts
 *
 * `verifiesTaskId` decides how a task is completed and also who reads the files its subject's evidence cites, so it is
 * written by those who answer for the work: the account owner, the project's coordinator and its judgment sessions. A run
 * of a task answers for that task. Asked of `TasksService.update` and of the two other doors that write the same facts:
 *
 *   (1) a run may not make another task a verifier, started or not, in a project or in none, and reads nothing for trying;
 *   (2) a run may not write any field of another task that is a verifier, started or not, in a project or in none;
 *   (3) a run may not conclude another task's verification, which would settle what that verification stands for;
 *   (4) the batch pin is the same write of the same fields;
 *   (5) a run files a verifier only on the owner's answered card: the door that files one checks for the card itself;
 *   (6) everybody else is as they were: the owner, the coordinator, a judgment session, a verifier's own run, a run editing
 *       an ordinary sibling, a conversation of no task, and the file read of a verifier the coordinator made.
 *
 * Refusals are asserted on literals rather than on the constants the change adds, so that this file compiles and fails
 * against code that has no such door.
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import type { Prisma, PrismaClient, RunStatus } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import '../test-support/daemon-routes-over-http';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const PROVIDER_SECRET_KEY = `verifier-write-${RUN}`;
const STANDARD = 'the work is checked by somebody who did not do it';
const WRITE_REFUSED = 'VERIFIER_WRITE_FROM_RUN_REFUSED';
// Since the control plane cards EVERY session create by caller (`task-write-approval.ts`), the
// door answers a run's uncarded verifier create with the universal code: the verifier rule below
// still requires the card to name the verifiers, and a card that covers the whole body does.
const CARD_REQUIRED = 'TASK_WRITE_NEEDS_OWNER_CARD';

const b62 = (id: string) => uuidToBase62(id);

test('who may write the verification relation', { skip: !URL, concurrency: 1, timeout: 600_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  process.env.PROVIDER_SECRET_KEY = PROVIDER_SECRET_KEY;
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-verifier-write-'));
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const jwtSecret = `verifier-write-${randomUUID()}`;
  server = await startApiserver(url, jwtSecret, {
    PROVIDER_SECRET_KEY,
    MODEL_CATALOG_URL: 'http://127.0.0.1:9/',
    ORBIT_FILES_BACKEND: 'local',
    ORBIT_FILES_DIR: dir,
  });
  const api = server;

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const token = `${runnerId}-${RUN}`;
  const email = `owner-${RUN}@verifier-write.invalid`;
  await db.user.create({ data: { id: ownerId, email, name: 'owner', passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'machine', status: 'ONLINE', lastHeartbeatAt: new Date(Date.now() + 3_600_000),
      tokenHash: createHash('sha256').update(token).digest('hex'),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'one', enabled: true } });
  await db.workspace.create({ data: { id: otherWorkspaceId, ownerId, runnerId, name: 'two', enabled: true } });
  const bearer = await new JwtService({ secret: jwtSecret }).signAsync({ sub: ownerId, email });

  const sessionOf = async (title: string, taskId?: string, status: RunStatus = 'AWAITING_INPUT') => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, title, prompt: title, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, status,
        startedAt: new Date(), runtimeSessionId: `runtime-${id}`, provider: 'claude', taskId, startsTaskWork: taskId !== undefined,
      },
    });
    return id;
  };
  const projectOf = async (title: string) => {
    const id = randomUUID();
    const coordinator = await sessionOf(`coordinating ${title}`);
    await db.project.create({
      data: {
        id, ownerId, title, coordinatorEnabled: true, coordinatorWorkspaceId: workspaceId, coordinatorSessionId: coordinator,
        startedAt: new Date(),
      },
    });
    await db.projectRuntime.upsert({ where: { projectId: id }, create: { projectId: id }, update: {} });
    const definitionId = randomUUID();
    await db.projectAcceptanceCriterionDefinition.create({
      data: { id: definitionId, projectId: id, ordinal: 1, text: STANDARD, verificationMethod: 'read it', contentHash: '0'.repeat(64) },
    });
    return { id, coordinator, definitionId };
  };
  type Project = Awaited<ReturnType<typeof projectOf>>;
  const taskOf = async (title: string, on: Project | null, extra: Partial<Prisma.TaskUncheckedCreateInput> = {}) => {
    const id = randomUUID();
    await db.task.create({
      data: {
        id, title, ownerId, creatorType: 'USER', creatorId: ownerId, assigneeId: workspaceId,
        status: 'OPEN', completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: STANDARD,
        ...(on ? { projectId: on.id, criterionDefinitionId: on.definitionId, criterionRevision: 1 } : {}),
        ...extra,
      },
    });
    return id;
  };
  const workOf = async (title: string, on: Project | null, extra: Partial<Prisma.TaskUncheckedCreateInput> = {}) => {
    const taskId = await taskOf(title, on, { status: 'IN_PROGRESS', ...extra });
    return { taskId, sessionId: await sessionOf(`a run of ${title}`, taskId) };
  };
  const verifierExtra = (subject: string): Partial<Prisma.TaskUncheckedCreateInput> => ({
    completionCriterion: 'VERIFICATION', verifiesTaskId: subject, criterionDefinitionId: null, criterionRevision: null,
  });

  const patch = (sessionId: string | undefined, taskId: string, body: unknown) =>
    call(api, 'PATCH', `/api/runner/tasks/${b62(taskId)}`, token, body, sessionId ? { 'x-orbit-session-id': sessionId } : {});
  const patchAsOwner = (taskId: string, body: unknown) => call(api, 'PATCH', `/api/tasks/${b62(taskId)}`, bearer, body);
  const row = (taskId: string) => db.task.findUniqueOrThrow({ where: { id: taskId } });
  /** The whole row, `updatedAt` included, so that a write that changed nothing else still shows. */
  const stands = async (taskId: string) => JSON.stringify(await row(taskId), (_, value) => (typeof value === 'bigint' ? String(value) : value));
  const ok = (reply: Reply, what: string) => {
    assert.ok(reply.status >= 200 && reply.status < 300, `${what} answered ${reply.status}: ${reply.text.slice(0, 500)}`);
    return reply.json;
  };
  /** Refused with this code, in a sentence, and whatever else was asked of the row stands as it was. */
  const refused = (reply: Reply, code: string, what: string) => {
    assert.deepEqual([reply.status, reply.json?.code], [403, code], `${what} answered ${reply.status}: ${reply.text.slice(0, 500)}`);
    assert.equal(reply.json.kind, 'REFUSAL');
    assert.ok(typeof reply.json.requiredAction === 'string' && reply.json.requiredAction.length > 0, what);
    assert.match(reply.json.message, /Nothing was written/, what);
  };
  const refusedWrite = async (sessionId: string, taskId: string, body: unknown, what: string) => {
    const before = await stands(taskId);
    const reply = await patch(sessionId, taskId, body);
    refused(reply, WRITE_REFUSED, what);
    assert.match(reply.json.message, /coordinator/, 'it says who can make the edit');
    assert.match(reply.json.message, /owner/, 'it says who can make the edit');
    assert.equal(await stands(taskId), before, `${what} left the row as it was`);
  };

  /** What a session is answered for a file, at the two doors `file_fetch` calls in turn. */
  const statusesOf = async (sessionId: string, fileId: string) => {
    const described = await call(api, 'GET', `/api/runner/sessions/${b62(sessionId)}/files/${fileId}`, token);
    const bytes = await fetch(`http://127.0.0.1:${api.port}/api/runner/sessions/${b62(sessionId)}/attachments/${fileId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { statuses: [described.status, bytes.status], data: Buffer.from(await bytes.arrayBuffer()) };
  };
  const readsNothing = async (sessionId: string, fileId: string, who: string) => {
    assert.deepEqual((await statusesOf(sessionId, fileId)).statuses, [404, 404], who);
  };
  const reads = async (sessionId: string, fileId: string, bytes: Buffer, who: string) => {
    const answer = await statusesOf(sessionId, fileId);
    assert.deepEqual(answer.statuses, [200, 200], who);
    assert.ok(answer.data.equals(bytes), who);
  };
  const toolCallOf = async (sessionId: string) => {
    const toolUseId = `toolu_${randomUUID()}`;
    await db.toolCall.create({ data: { sessionId, name: 'Bash', toolUseId, input: { command: 'npm test' }, isError: false } });
    return { kind: 'TOOL_CALL', ref: toolUseId };
  };
  /** A file the subject's run keeps and its evidence cites: what the relation is a grant of. */
  const citedFileOf = async (work: { taskId: string; sessionId: string }, on: Project | null) => {
    const bytes = randomBytes(300);
    const boundary = `verifier-write-${randomUUID()}`;
    const uploaded = await fetch(`http://127.0.0.1:${api.port}/api/runner/sessions/${b62(work.sessionId)}/files`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; filename="report.bin"; name=file\r\nContent-Type: application/octet-stream\r\n\r\n`),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
    assert.equal(uploaded.status, 201, 'the upload');
    const fileId = b62(toUuid(((await uploaded.json()) as { id: string }).id));
    const evidence = {
      claim: 'the file shows it',
      criterion: { key: b62(on ? on.definitionId : work.taskId), text: STANDARD },
      checks: [await toolCallOf(work.sessionId), { kind: 'FILE', ref: fileId }],
      gaps: [],
    };
    ok(await call(api, 'POST', `/api/runner/tasks/${b62(work.taskId)}/evidence`, token, { evidence }, { 'x-orbit-session-id': work.sessionId }), 'the evidence');
    return { fileId, bytes };
  };

  const project = await projectOf('the project');
  const subject = await workOf('the subject', project);
  const file = await citedFileOf(subject, project);
  const peer = await workOf('a peer', project);
  const secondSubject = await taskOf('a second subject', project);

  /** Every kind of field a PATCH can carry, on the row it is sent at. `other` is a task of the same project, in no relation. */
  const FIELD_WRITES: Array<[string, (other: string) => Record<string, unknown>]> = [
    ['title', () => ({ title: 'renamed' })],
    ['description', () => ({ description: 'other instructions' })],
    ['acceptanceCriteria', () => ({ acceptanceCriteria: 'another standard' })],
    ['a completion standard a verifier cannot have', () => ({ completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0, completionCriterionOverrideReason: 'asked' })],
    ['assigneeId', () => ({ assigneeId: b62(otherWorkspaceId) })],
    ['engine', () => ({ engine: 'codex' })],
    ['model', () => ({ model: 'another-model' })],
    ['status', () => ({ status: 'CANCELLED' })],
    ['verdict', () => ({ verdict: 'PASS' })],
    ['a verdict revoked', () => ({ verdict: null })],
    ['re-pointing the subject', () => ({ verifiesTaskId: b62(secondSubject) })],
    ['the completion standard, by detaching', () => ({ verifiesTaskId: null, completionCriterion: 'EVIDENCE_JUDGMENT', completionCriterionOverrideReason: 'asked' })],
    ['restating the subject', () => ({ verifiesTaskId: b62(subject.taskId) })],
    ['priority', () => ({ priority: 5 })],
    ['labels', () => ({ labels: ['moved'] })],
    ['dependsOnTaskIds', (other) => ({ dependsOnTaskIds: [b62(other)] })],
    ['parentTaskId', (other) => ({ parentTaskId: b62(other) })],
    ['autoRunWhenReady', () => ({ autoRunWhenReady: true })],
    ['runAt', () => ({ runAt: new Date(Date.now() + 3_600_000).toISOString() })],
    ['codeless', () => ({ codeless: true, codelessReason: 'asked' })],
  ];

  await t.test('(1) a run may not make another task a verifier', async (t) => {
    await t.test('a sibling nobody has started', async () => {
      const idle = await taskOf('an open sibling', project);
      await refusedWrite(peer.sessionId, idle, {
        verifiesTaskId: b62(subject.taskId), completionCriterionOverrideReason: 'asked', description: 'other instructions',
      }, 'attaching');
    });
    await t.test('a sibling already running, whose run reads nothing for it', async () => {
      const running = await workOf('a running sibling', project);
      await readsNothing(running.sessionId, file.fileId, 'before');
      await refusedWrite(peer.sessionId, running.taskId, {
        verifiesTaskId: b62(subject.taskId), completionCriterionOverrideReason: 'asked',
      }, 'attaching');
      await readsNothing(running.sessionId, file.fileId, 'the sibling\'s run, after');
      await readsNothing(peer.sessionId, file.fileId, 'the acting run, after');
    });
    await t.test('in no project', async () => {
      const lonelySubject = await workOf('a subject in no project', null);
      const lonelyFile = await citedFileOf(lonelySubject, null);
      const lonelyPeer = await workOf('a peer in no project', null);
      const idle = await taskOf('an open task in no project', null);
      const running = await workOf('a running task in no project', null);
      await refusedWrite(lonelyPeer.sessionId, idle, {
        verifiesTaskId: b62(lonelySubject.taskId), completionCriterionOverrideReason: 'asked',
      }, 'attaching in no project');
      await refusedWrite(lonelyPeer.sessionId, running.taskId, {
        verifiesTaskId: b62(lonelySubject.taskId), completionCriterionOverrideReason: 'asked',
      }, 'attaching in no project, a running one');
      await readsNothing(running.sessionId, lonelyFile.fileId, 'the running task\'s run, after');
      await readsNothing(lonelyPeer.sessionId, lonelyFile.fileId, 'the acting run, after');
    });
    await t.test('a verifier\'s own run is a run too', async () => {
      const verifier = await workOf('verifying the subject', project, verifierExtra(subject.taskId));
      const idle = await taskOf('an open sibling', project);
      await refusedWrite(verifier.sessionId, idle, {
        verifiesTaskId: b62(secondSubject), completionCriterionOverrideReason: 'asked',
      }, 'attaching, from a verifier\'s run');
    });
  });

  await t.test('(2) a run may not write any field of another task that is a verifier', async (t) => {
    const unrelated = await taskOf('in no relation', project);
    const notStarted = await taskOf('a verifier nobody has started', project, verifierExtra(subject.taskId));
    const running = await workOf('a running verifier', project, verifierExtra(subject.taskId));
    for (const [name, body] of FIELD_WRITES) {
      await t.test(`${name}, a verifier not started`, () => refusedWrite(peer.sessionId, notStarted, body(unrelated), name));
      await t.test(`${name}, a running verifier`, () => refusedWrite(peer.sessionId, running.taskId, body(unrelated), name));
    }
    await t.test('asking for a move is writing the row too', async () => {
      const elsewhere = await projectOf('elsewhere');
      await refusedWrite(peer.sessionId, notStarted, { projectId: b62(elsewhere.id), handoff: { reason: 'asked' } }, 'a move');
    });
    await t.test('from the subject\'s own run', () => refusedWrite(subject.sessionId, notStarted, { description: 'other instructions' }, 'the subject\'s run'));
    await t.test('from the run of another verifier', async () => {
      const another = await workOf('verifying something else', project, verifierExtra(secondSubject));
      await refusedWrite(another.sessionId, notStarted, { description: 'other instructions' }, 'another verifier\'s run');
    });
    await t.test('in no project', async () => {
      const lonelySubject = await workOf('a subject in no project', null);
      const lonelyPeer = await workOf('a peer in no project', null);
      const lonely = await taskOf('a verifier in no project', null, { completionCriterion: 'VERIFICATION', verifiesTaskId: lonelySubject.taskId });
      for (const [name, body] of FIELD_WRITES.filter(([name]) => ['description', 'acceptanceCriteria', 'engine', 'verdict'].includes(name))) {
        await refusedWrite(lonelyPeer.sessionId, lonely, body(lonelySubject.taskId), `${name} in no project`);
      }
    });
  });

  await t.test('(3) a run may not conclude another task\'s verification', async (t) => {
    /** What became of the verdict and of what it settles, so that the answer on any code is what the failure prints. */
    const after = async (reply: Reply, check: string, settled: string) => ({
      answered: reply.status,
      code: reply.json?.code ?? null,
      verdict: (await row(check)).verdict,
      subject: (await row(settled)).status,
    });
    await t.test('a PASS, which would settle the subject', async () => {
      const settled = await taskOf('settled by a check', project, { completionCriterion: 'VERIFICATION', completionPolicy: 'VERIFICATION_PASSED' });
      const check = await taskOf('the check', project, verifierExtra(settled));
      assert.deepEqual(await after(await patch(peer.sessionId, check, { verdict: 'PASS' }), check, settled), {
        answered: 403, code: WRITE_REFUSED, verdict: null, subject: 'OPEN',
      });
    });
    await t.test('a PASS in no project', async () => {
      const lonelyPeer = await workOf('a peer in no project', null);
      const settled = await taskOf('in no project', null, { completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 });
      const check = await taskOf('its check', null, { completionCriterion: 'VERIFICATION', verifiesTaskId: settled });
      assert.deepEqual(await after(await patch(lonelyPeer.sessionId, check, { verdict: 'PASS' }), check, settled), {
        answered: 403, code: WRITE_REFUSED, verdict: null, subject: 'OPEN',
      });
    });
    await t.test('revoking a FAIL', async () => {
      const settled = await taskOf('held by a FAIL', project, { completionCriterion: 'VERIFICATION', completionPolicy: 'VERIFICATION_PASSED' });
      const check = await taskOf('the check that failed', project, verifierExtra(settled));
      ok(await patchAsOwner(check, { verdict: 'FAIL' }), 'the owner\'s FAIL');
      assert.deepEqual(await after(await patch(peer.sessionId, check, { verdict: null }), check, settled), {
        answered: 403, code: WRITE_REFUSED, verdict: 'FAIL', subject: 'OPEN',
      });
    });
  });

  await t.test('(4) the batch pin writes the same fields', async (t) => {
    const pin = (sessionId: string | undefined, body: unknown) =>
      call(api, 'POST', '/api/runner/tasks/batch-pin', token, body, sessionId ? { 'x-orbit-session-id': sessionId } : {});
    const pinProject = await projectOf('a project to pin');
    const pinPeer = await workOf('a peer', pinProject);
    const ordinary = await taskOf('an ordinary sibling', pinProject);
    const pinSubject = await taskOf('a subject', pinProject);
    const check = await taskOf('its check', pinProject, verifierExtra(pinSubject));
    const checkRun = await workOf('its running check', pinProject, verifierExtra(pinSubject));

    await t.test('a run may not name a verifier', async () => {
      const before = await stands(check);
      refused(await pin(pinPeer.sessionId, { taskIds: [b62(check)], model: 'pinned-by-a-peer' }), WRITE_REFUSED, 'by id');
      assert.equal(await stands(check), before);
    });
    await t.test('nor select one, and then nothing of the selection is written', async () => {
      const before = [await stands(check), await stands(ordinary)];
      refused(await pin(pinPeer.sessionId, { projectId: b62(pinProject.id), model: 'pinned-by-a-peer' }), WRITE_REFUSED, 'by project');
      assert.deepEqual([await stands(check), await stands(ordinary)], before);
    });
    await t.test('a run may pin an ordinary sibling', async () => {
      const sibling = await taskOf('another ordinary sibling', pinProject);
      assert.deepEqual(ok(await pin(pinPeer.sessionId, { taskIds: [b62(sibling)], model: 'pinned-by-a-peer' }), 'an ordinary sibling'), { changed: 1 });
    });
    await t.test('a verifier\'s run may pin itself, not another verifier', async () => {
      assert.deepEqual(ok(await pin(checkRun.sessionId, { taskIds: [b62(checkRun.taskId)], model: 'mine' }), 'itself'), { changed: 1 });
      refused(await pin(checkRun.sessionId, { taskIds: [b62(checkRun.taskId), b62(check)], model: 'mine-too' }), WRITE_REFUSED, 'another verifier');
    });
    await t.test('the coordinator, a conversation of no task, and a call with no session pin a verifier', async () => {
      assert.deepEqual(ok(await pin(pinProject.coordinator, { taskIds: [b62(check)], model: 'by-the-coordinator' }), 'the coordinator'), { changed: 1 });
      const conversation = await sessionOf('a conversation');
      assert.deepEqual(ok(await pin(conversation, { taskIds: [b62(check)], model: 'by-a-conversation' }), 'a conversation'), { changed: 1 });
      assert.deepEqual(ok(await pin(undefined, { projectId: b62(pinProject.id), model: 'by-no-session' }), 'no session').changed > 0, true);
    });
  });

  await t.test('(5) a run files a verifier only on the owner\'s answered card', async (t) => {
    const cardProject = await projectOf('a project of cards');
    const cardPeer = await workOf('a peer', cardProject);
    const cardSubject = await workOf('a subject', cardProject);
    const createdTitled = (title: string) => db.task.count({ where: { ownerId, title } });
    const create = (sessionId: string | undefined, body: unknown) => call(api, 'POST', '/api/runner/tasks', token, body, {
      ...(sessionId ? { 'x-orbit-session-id': sessionId } : {}), 'x-orbit-workspace-id': b62(workspaceId),
    });
    const batch = (sessionId: string | undefined, tasks: unknown[], extra: object = {}) => call(api, 'POST', '/api/runner/tasks/batch-create', token, { tasks, ...extra }, {
      ...(sessionId ? { 'x-orbit-session-id': sessionId } : {}), 'x-orbit-workspace-id': b62(workspaceId),
    });
    const verifierBody = (title: string, verifies = cardSubject.taskId) => ({
      title, completionCriterion: 'VERIFICATION', verifiesTaskId: b62(verifies), projectId: b62(cardProject.id),
    });
    const pairBody = (title: string) => ({
      title, completionCriterion: 'VERIFICATION', completionPolicy: 'VERIFICATION_PASSED', projectId: b62(cardProject.id),
      verification: { title: `checking ${title}` },
    });
    const batchPair = (title: string) => [
      { ref: 'phase', title, completionCriterion: 'VERIFICATION', completionPolicy: 'VERIFICATION_PASSED', projectId: b62(cardProject.id) },
      { title: `checking ${title}`, completionCriterion: 'VERIFICATION', verifiesRef: 'phase', projectId: b62(cardProject.id) },
    ];
    /** A card as the approvals route files it, in the state its answer left it in. */
    const cardOf = (sessionId: string, toolName: string, input: Prisma.InputJsonValue, status = 'ALLOWED', decidedById: string | null = ownerId) =>
      db.approval.create({ data: { sessionId, toolName, input, status, decidedById, decidedAt: status === 'PENDING' ? null : new Date() } });

    await t.test('with no card, each spelling of a verifier is refused and nothing is written', async () => {
      refused(await create(cardPeer.sessionId, verifierBody('no card')), CARD_REQUIRED, 'task_create verifiesTaskId');
      refused(await create(cardPeer.sessionId, pairBody('no card pair')), CARD_REQUIRED, 'task_create verification');
      refused(await batch(cardPeer.sessionId, [verifierBody('no card batch')]), CARD_REQUIRED, 'task_create_batch verifiesTaskId');
      refused(await batch(cardPeer.sessionId, batchPair('no card batch pair')), CARD_REQUIRED, 'task_create_batch verifiesRef');
      for (const title of ['no card', 'no card pair', 'checking no card pair', 'no card batch', 'no card batch pair', 'checking no card batch pair']) {
        assert.equal(await createdTitled(title), 0, title);
      }
    });
    await t.test('in no project too', async () => {
      const lonelySubject = await workOf('a subject in no project', null);
      const lonelyPeer = await workOf('a peer in no project', null);
      refused(await create(lonelyPeer.sessionId, {
        title: 'no card in no project', completionCriterion: 'VERIFICATION', verifiesTaskId: b62(lonelySubject.taskId),
      }), CARD_REQUIRED, 'in no project');
    });
    await t.test('a card that was not answered yes, or is about something else, is no card', async () => {
      const body = verifierBody('a card of another kind');
      await cardOf(cardPeer.sessionId, 'orbit_task_create', body, 'PENDING', null);
      await cardOf(cardPeer.sessionId, 'orbit_task_create', body, 'DENIED');
      await cardOf(cardPeer.sessionId, 'orbit_task_create', body, 'ABANDONED', null);
      await cardOf(cardPeer.sessionId, 'orbit_task_batch', { tasks: [body] });
      await cardOf(cardPeer.sessionId, 'orbit_task_create', verifierBody('a card of another kind', secondSubject));
      await cardOf(cardPeer.sessionId, 'orbit_task_create', verifierBody('a card of another title'));
      await cardOf(subject.sessionId, 'orbit_task_create', body);
      await cardOf(cardPeer.sessionId, 'orbit_some_other_tool', body);
      refused(await create(cardPeer.sessionId, body), CARD_REQUIRED, 'not one of those covers it');
      assert.equal(await createdTitled(body.title), 0);
    });
    await t.test('a batch needs every verifier of it on one card', async () => {
      const first = verifierBody('first of two');
      const second = verifierBody('second of two');
      await cardOf(cardPeer.sessionId, 'orbit_task_batch', { tasks: [first] });
      await cardOf(cardPeer.sessionId, 'orbit_task_batch', { tasks: [second] });
      refused(await batch(cardPeer.sessionId, [first, second]), CARD_REQUIRED, 'two cards of one each');
      assert.equal(await createdTitled('first of two'), 0);
    });
    await t.test('the answered card lets each spelling through, and its id may be spelled either way', async () => {
      const single = verifierBody('on a card');
      await cardOf(cardPeer.sessionId, 'orbit_task_create', { ...single, verifiesTaskId: cardSubject.taskId, acceptsStartAfterCreate: true, preview: {} });
      assert.equal(ok(await create(cardPeer.sessionId, single), 'task_create verifiesTaskId').verifiesTaskId, b62(cardSubject.taskId));

      const pair = pairBody('a pair on a card');
      await cardOf(cardPeer.sessionId, 'orbit_task_create', pair);
      assert.ok(ok(await create(cardPeer.sessionId, pair), 'task_create verification').verification.id);

      const inBatch = verifierBody('in a batch on a card');
      await cardOf(cardPeer.sessionId, 'orbit_task_batch', { tasks: [inBatch], preview: {} });
      ok(await batch(cardPeer.sessionId, [inBatch]), 'task_create_batch verifiesTaskId');

      const batched = batchPair('a batch pair on a card');
      await cardOf(cardPeer.sessionId, 'orbit_task_batch', { tasks: batched, preview: {} });
      ok(await batch(cardPeer.sessionId, batched), 'task_create_batch verifiesRef');
    });
    await t.test('a standing grant answered that card as well, as it does at the tool', async () => {
      const body = verifierBody('on a standing grant');
      await cardOf(cardPeer.sessionId, 'orbit_task_create', body, 'ALLOWED', null);
      ok(await create(cardPeer.sessionId, body), 'a standing grant');
    });
    await t.test('asking what a plan would do, which is what fills the card, needs no card', async () => {
      ok(await batch(cardPeer.sessionId, batchPair('only a preview'), { dryRun: true }), 'a dry run');
      ok(await call(api, 'POST', '/api/runner/tasks/batch-preview', token, { tasks: batchPair('only a preview') }, { 'x-orbit-session-id': cardPeer.sessionId }), 'the card\'s preview');
      assert.equal(await createdTitled('only a preview'), 0);
    });
    await t.test('the card route and the owner\'s answer are the card this reads', async () => {
      const body = verifierBody('through the approvals route');
      const filed = ok(await call(api, 'POST', `/api/runner/sessions/${b62(cardPeer.sessionId)}/approvals`, token, { toolName: 'orbit_task_create', input: body, acceptsStartAfterCreate: true }), 'the card');
      refused(await create(cardPeer.sessionId, body), CARD_REQUIRED, 'before it is answered');
      ok(await call(api, 'POST', `/api/sessions/${b62(cardPeer.sessionId)}/approvals/${filed.id}/decision`, bearer, { behavior: 'allow' }), 'the owner\'s yes');
      ok(await create(cardPeer.sessionId, body), 'after it is answered');
    });
    await t.test('an ordinary task from a run needs its card too', async () => {
      const body = {
        title: 'an ordinary task', completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: STANDARD,
        projectId: b62(cardProject.id), criterionKey: b62(cardProject.definitionId),
      };
      // A different question from the verifier rule above: every session create is carded, verifier
      // or not, and the server refuses a write no answered card covers (task-write-approval.ts).
      refused(await create(cardPeer.sessionId, body), 'TASK_WRITE_NEEDS_OWNER_CARD', 'an ordinary task with no card');
      await cardOf(cardPeer.sessionId, 'orbit_task_create', body);
      ok(await create(cardPeer.sessionId, body), 'an ordinary task on its answered card');
    });
    await t.test('the coordinator, a judgment session and the owner file verifiers as before', async () => {
      const pair = pairBody('a coordinator\'s pair');
      await cardOf(cardProject.coordinator, 'orbit_task_create', pair);
      assert.ok(ok(await create(cardProject.coordinator, pair), 'a coordinator\'s pair').verification.id);
      const coordinatorBatch = batchPair('a coordinator\'s batch pair');
      await cardOf(cardProject.coordinator, 'orbit_task_batch', { tasks: coordinatorBatch, preview: {} });
      assert.equal(ok(await batch(cardProject.coordinator, coordinatorBatch), 'a coordinator\'s batch pair').length, 2);
      const check = verifierBody('a coordinator\'s check');
      await cardOf(cardProject.coordinator, 'orbit_task_create', check);
      ok(await create(cardProject.coordinator, check), 'a coordinator\'s check');

      const judgment = await sessionOf('a judgment session');
      await db.projectCoordinatorWake.create({
        data: {
          id: randomUUID(), projectId: cardProject.id, event: 'CRITERION_READY', subjectType: 'CRITERION', subjectId: `${cardProject.id}:judged`,
          subjectVersion: '1', idempotencyKey: `verifier-write-create-${RUN}`, status: 'SESSION_OPENED', sessionId: judgment,
        },
      });
      await db.session.update({ where: { id: judgment }, data: { dispatchOrigin: 'PROJECT_COORDINATOR' } });
      const judged = { ...verifierBody('a judgment\'s check'), criterionKey: b62(cardProject.definitionId) };
      await cardOf(judgment, 'orbit_task_create', judged);
      ok(await create(judgment, judged), 'a judgment\'s check');

      ok(await call(api, 'POST', '/api/tasks', bearer, verifierBody('the owner\'s check')), 'the owner\'s check');
      assert.equal(ok(await call(api, 'POST', '/api/tasks/batch-create', bearer, { tasks: batchPair('the owner\'s pair') }), 'the owner\'s pair').length, 2);
    });
  });

  await t.test('(6) everybody else is as they were', async (t) => {
    const judgment = await sessionOf('a judgment session of the project');
    await db.projectCoordinatorWake.create({
      data: {
        id: randomUUID(), projectId: project.id, event: 'CRITERION_READY', subjectType: 'CRITERION', subjectId: `${project.id}:judged`,
        subjectVersion: '1', idempotencyKey: `verifier-write-update-${RUN}`, status: 'SESSION_OPENED', sessionId: judgment,
      },
    });
    await db.session.update({ where: { id: judgment }, data: { dispatchOrigin: 'PROJECT_COORDINATOR' } });

    await t.test('the coordinator makes a verifier, edits it, and its run reads the file', async () => {
      const made = await workOf('made a verifier by the coordinator', project);
      await readsNothing(made.sessionId, file.fileId, 'before');
      ok(await patch(project.coordinator, made.taskId, {
        verifiesTaskId: b62(subject.taskId), completionCriterionOverrideReason: 'this checks the subject',
      }), 'the coordinator attaching');
      assert.equal((await row(made.taskId)).verifiesTaskId, subject.taskId);
      await reads(made.sessionId, file.fileId, file.bytes, 'the verifier the coordinator made');
      ok(await patch(project.coordinator, made.taskId, { description: 'new instructions', acceptanceCriteria: 'a new standard', assigneeId: b62(otherWorkspaceId), engine: 'codex' }), 'the coordinator editing');
      assert.equal((await row(made.taskId)).description, 'new instructions');
      ok(await patch(project.coordinator, made.taskId, { verdict: 'PASS' }), 'the coordinator concluding');
      assert.equal((await row(made.taskId)).verdict, 'PASS');
    });
    await t.test('the owner does, with no session, at either door', async () => {
      const target = await taskOf('for the owner', project);
      ok(await patchAsOwner(target, { verifiesTaskId: b62(subject.taskId), completionCriterionOverrideReason: 'this checks the subject' }), 'the owner attaching');
      ok(await patchAsOwner(target, { description: 'by the owner', engine: 'codex' }), 'the owner editing');
      ok(await patch(undefined, target, { description: 'by the owner\'s CLI' }), 'a call with no session');
      ok(await patchAsOwner(target, { verdict: 'FAIL' }), 'the owner concluding');
      assert.equal((await row(target)).verdict, 'FAIL');
    });
    await t.test('a judgment session does', async () => {
      const target = await taskOf('for a judgment', project);
      ok(await patch(judgment, target, { verifiesTaskId: b62(subject.taskId), completionCriterionOverrideReason: 'this checks the subject' }), 'a judgment attaching');
      ok(await patch(judgment, target, { description: 'by a judgment' }), 'a judgment editing');
      ok(await patch(judgment, target, { verdict: 'PASS' }), 'a judgment concluding');
      assert.equal((await row(target)).verdict, 'PASS');
    });
    await t.test('a verifier\'s own run writes its own task and its verdict', async () => {
      const own = await workOf('a verifier of its own', project, verifierExtra(subject.taskId));
      ok(await patch(own.sessionId, own.taskId, { description: 'what I found so far' }), 'its description');
      ok(await patch(own.sessionId, own.taskId, { verdict: 'PASS' }), 'its verdict');
      assert.equal((await row(own.taskId)).verdict, 'PASS');
      ok(await patch(own.sessionId, own.taskId, { verdict: 'FAIL' }), 'its verdict again');
      assert.equal((await row(own.taskId)).verdict, 'FAIL');
    });
    await t.test('a verifier\'s own run still may not change what it answers to', async () => {
      const own = await workOf('a verifier with a standard', project, verifierExtra(secondSubject));
      const reply = await patch(own.sessionId, own.taskId, { verifiesTaskId: b62(subject.taskId) });
      assert.deepEqual([reply.status, reply.json.code], [403, 'TASK_COMPLETION_STANDARD_SELF_REWRITE_REFUSED'], reply.text);
    });
    await t.test('a run may not make its own task a verifier, as before', async () => {
      const own = await workOf('a run of its own', project);
      const reply = await patch(own.sessionId, own.taskId, { verifiesTaskId: b62(subject.taskId), completionCriterionOverrideReason: 'asked' });
      assert.deepEqual([reply.status, reply.json.code], [403, 'TASK_COMPLETION_STANDARD_SELF_REWRITE_REFUSED'], reply.text);
    });
    await t.test('a run edits an ordinary sibling, a subject among them', async () => {
      const sibling = await taskOf('an ordinary sibling', project);
      ok(await patch(peer.sessionId, sibling, { title: 'renamed by a peer', description: 'by a peer', labels: ['peer'], priority: 3 }), 'a peer editing');
      assert.equal((await row(sibling)).title, 'renamed by a peer');
      ok(await patch(peer.sessionId, sibling, { verifiesTaskId: null, description: 'naming no subject is no attaching' }), 'a peer naming no subject');
      ok(await patch(peer.sessionId, subject.taskId, { description: 'a subject is not a verifier' }), 'a peer editing a subject');
      const running = await workOf('a running sibling', project);
      ok(await patch(peer.sessionId, running.taskId, { description: 'by a peer' }), 'a peer editing a running sibling');
    });
    await t.test('in no project a run edits an ordinary task, and a conversation of no task edits a verifier', async () => {
      const lonelySubject = await taskOf('a subject in no project', null, { completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 });
      const lonelyPeer = await workOf('a peer in no project', null);
      const lonely = await taskOf('an open task in no project', null, { completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0 });
      ok(await patch(lonelyPeer.sessionId, lonely, { description: 'by a peer' }), 'a peer editing an ordinary task');
      const check = await taskOf('a check in no project', null, { completionCriterion: 'VERIFICATION', verifiesTaskId: lonelySubject });
      const conversation = await sessionOf('a conversation');
      ok(await patch(conversation, check, { description: 'by a conversation' }), 'a conversation editing a verifier in no project');
    });
    await t.test('inside a project a conversation of no task is refused as it was', async () => {
      const conversation = await sessionOf('a conversation');
      const check = await taskOf('a check', project, verifierExtra(subject.taskId));
      const reply = await patch(conversation, check, { description: 'by a conversation' });
      assert.deepEqual([reply.status, reply.json.code], [403, 'PROJECT_SCOPE_MISMATCH'], reply.text);
    });
    await t.test('a direct DONE is still refused for its own reason', async () => {
      const check = await taskOf('a check', project, verifierExtra(subject.taskId));
      const reply = await patch(peer.sessionId, check, { status: 'DONE' });
      assert.deepEqual([reply.status, reply.json.code], [403, 'DIRECT_TASK_DONE_REFUSED'], reply.text);
    });
  });
});
