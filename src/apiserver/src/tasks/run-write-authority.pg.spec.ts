/**
 * What a run answers for, and what it does not, held against the production apiserver — `build/main.js` and every guard and
 * pipe in front of the routes — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/run-write-authority.pg.spec.ts
 *
 * A run answers for its own task. What settles another task, or what decides whether a criterion of the project is met, is
 * for those who answer for the work as a whole: the account owner, the project's coordinator and its judgment sessions.
 *
 *   (1) a run may not decide another task's evidence, CONFIRM or SEND_BACK, unless that evidence is addressed to it;
 *   (2) everybody the evidence is addressed to decides as before, and so does the account owner, whichever session they name;
 *   (3) the pending read does not ask a run what the door would refuse it;
 *   (4) a conversation a run opened answers as that run, at every door here and at the doors of the verification relation;
 *   (5) a conversation anybody else opened is as it was;
 *   (6) a run deletes only ordinary work it filed itself;
 *   (7) a run does not change what a verifier waits for: one edge at a time, or in a batch without the owner's card;
 *   (8) a run does not report a verifier's progress;
 *   (9) a run does not write which criterion another task serves;
 *  (10) cancelling or failing work serving a criterion does not satisfy it, and stays a run's to do;
 *  (11) a run does not write what settles another task, unless it filed that task itself and it serves no criterion.
 *
 * Refusals are asserted on literals rather than on the constants the change adds, so that this file compiles and fails
 * against code that has no such door. A request that names no session reads as the owner at each door, because that is every
 * runner older than the one that names it there.
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { uuidToBase62 } from '@orbit/shared';
import type { Prisma, PrismaClient, RunStatus } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const PROVIDER_SECRET_KEY = `run-write-${RUN}`;
const STANDARD = 'the work is checked by somebody who did not do it';
const DECIDE_REFUSED = 'EVIDENCE_JUDGMENT_FROM_RUN_REFUSED';
const INDEPENDENCE_REFUSED = 'EVIDENCE_JUDGMENT_REQUIRES_INDEPENDENT_SESSION';
const ANOTHER_PROJECT_REFUSED = 'EVIDENCE_JUDGMENT_TASK_IN_ANOTHER_PROJECT';
const VERIFIER_REFUSED = 'VERIFIER_WRITE_FROM_RUN_REFUSED';
const CARD_REQUIRED = 'VERIFIER_CREATE_NEEDS_OWNER_CARD';
const DAG_CARD_REQUIRED = 'VERIFIER_DAG_NEEDS_OWNER_CARD';
const DELETE_REFUSED = 'TASK_DELETE_FROM_RUN_REFUSED';
const CRITERION_KEY_REFUSED = 'CRITERION_KEY_FROM_RUN_REFUSED';
const STANDARD_REFUSED = 'COMPLETION_STANDARD_FROM_RUN_REFUSED';
const SELF_REWRITE_REFUSED = 'TASK_COMPLETION_STANDARD_SELF_REWRITE_REFUSED';

const b62 = (id: string) => uuidToBase62(id);

test('what a run answers for', { skip: !URL, concurrency: 1, timeout: 900_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  process.env.PROVIDER_SECRET_KEY = PROVIDER_SECRET_KEY;
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-run-write-'));
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const jwtSecret = `run-write-${randomUUID()}`;
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
  const token = `${runnerId}-${RUN}`;
  const email = `owner-${RUN}@run-write.invalid`;
  await db.user.create({ data: { id: ownerId, email, name: 'owner', passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'machine', status: 'ONLINE', lastHeartbeatAt: new Date(Date.now() + 3_600_000),
      tokenHash: createHash('sha256').update(token).digest('hex'),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'one', enabled: true } });
  const bearer = await new JwtService({ secret: jwtSecret }).signAsync({ sub: ownerId, email });

  const sessionOf = async (title: string, taskId?: string, parentSessionId?: string, status: RunStatus = 'AWAITING_INPUT') => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, title, prompt: title, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, status,
        startedAt: new Date(), runtimeSessionId: `runtime-${id}`, provider: 'claude', taskId, startsTaskWork: taskId !== undefined, parentSessionId,
      },
    });
    return id;
  };
  const projectOf = async (title: string, coordinatorEnabled = true) => {
    const id = randomUUID();
    const coordinator = await sessionOf(`coordinating ${title}`);
    await db.project.create({
      data: {
        id, ownerId, title, coordinatorEnabled, coordinatorWorkspaceId: workspaceId, coordinatorSessionId: coordinator,
        startedAt: new Date(),
      },
    });
    await db.projectRuntime.upsert({ where: { projectId: id }, create: { projectId: id }, update: {} });
    const definitionId = randomUUID();
    const secondDefinitionId = randomUUID();
    for (const [ordinal, definition, text] of [[1, definitionId, STANDARD], [2, secondDefinitionId, `${STANDARD}, too`]] as const) {
      await db.projectAcceptanceCriterionDefinition.create({
        data: { id: definition, projectId: id, ordinal, text, verificationMethod: 'read it', contentHash: '0'.repeat(64) },
      });
    }
    return { id, coordinator, definitionId, secondDefinitionId };
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
  type Work = Awaited<ReturnType<typeof workOf>>;
  const verifierExtra = (subject: string): Partial<Prisma.TaskUncheckedCreateInput> => ({
    completionCriterion: 'VERIFICATION', verifiesTaskId: subject, criterionDefinitionId: null, criterionRevision: null,
  });
  const plainExtra: Partial<Prisma.TaskUncheckedCreateInput> = { criterionDefinitionId: null, criterionRevision: null };
  const filedBy = (sessionId: string): Partial<Prisma.TaskUncheckedCreateInput> => ({
    creatorType: 'AGENT', creatorId: workspaceId, creatorSessionId: sessionId,
  });
  const judgmentOf = async (on: Project, title: string) => {
    const judgment = await sessionOf(title);
    await db.projectCoordinatorWake.create({
      data: {
        id: randomUUID(), projectId: on.id, event: 'CRITERION_READY', subjectType: 'CRITERION', subjectId: `${on.id}:${randomUUID()}`,
        subjectVersion: '1', idempotencyKey: `run-write-${randomUUID()}`, status: 'SESSION_OPENED', sessionId: judgment,
      },
    });
    await db.session.update({ where: { id: judgment }, data: { dispatchOrigin: 'PROJECT_COORDINATOR' } });
    return judgment;
  };

  const header = (sessionId?: string): Record<string, string> => (sessionId ? { 'x-orbit-session-id': b62(sessionId) } : {});
  const row = (taskId: string) => db.task.findUniqueOrThrow({ where: { id: taskId } });
  /** The whole row, `updatedAt` included, so that a write that changed nothing else still shows. */
  const stands = async (taskId: string) => JSON.stringify(await row(taskId), (_, value) => (typeof value === 'bigint' ? String(value) : value));
  const exists = async (taskId: string) => (await db.task.count({ where: { id: taskId } })) === 1;
  const edgesOf = (taskId: string) => db.taskDependency.findMany({ where: { taskId }, select: { dependsOnTaskId: true } });
  const decisionsOf = (taskId: string) => db.taskEvidenceDecision.count({ where: { taskId } });
  const ok = (reply: Reply, what: string) => {
    assert.ok(reply.status >= 200 && reply.status < 300, `${what} answered ${reply.status}: ${reply.text.slice(0, 500)}`);
    return reply.json;
  };
  /** Refused with this code, as a sentence that says who can do it. */
  const refused = (reply: Reply, code: string, what: string) => {
    assert.deepEqual([reply.status, reply.json?.code], [403, code], `${what} answered ${reply.status}: ${reply.text.slice(0, 500)}`);
    assert.equal(reply.json.kind, 'REFUSAL', what);
    assert.ok(typeof reply.json.requiredAction === 'string' && reply.json.requiredAction.length > 0, what);
    assert.match(reply.json.message, /[Nn]othing was (written|deleted)/, what);
    assert.match(reply.json.message, /coordinator/, `${what}: it says who can do it`);
    assert.match(reply.json.message, /owner/, `${what}: it says who can do it`);
  };

  const patch = (sessionId: string | undefined, taskId: string, body: unknown) =>
    call(api, 'PATCH', `/api/runner/tasks/${b62(taskId)}`, token, body, header(sessionId));
  const remove = (sessionId: string | undefined, taskId: string) =>
    call(api, 'DELETE', `/api/runner/tasks/${b62(taskId)}`, token, undefined, header(sessionId));
  const addEdge = (sessionId: string | undefined, taskId: string, dependsOn: string) =>
    call(api, 'POST', `/api/runner/tasks/${b62(taskId)}/dependencies`, token, { dependsOnTaskId: b62(dependsOn) }, header(sessionId));
  const removeEdge = (sessionId: string | undefined, taskId: string, dependsOn: string) =>
    call(api, 'DELETE', `/api/runner/tasks/${b62(taskId)}/dependencies/${b62(dependsOn)}`, token, undefined, header(sessionId));
  const applyDag = (sessionId: string | undefined, listId: string, ops: unknown[]) =>
    call(api, 'POST', `/api/runner/task-lists/${b62(listId)}/dag-apply`, token, { ops }, header(sessionId));
  const report = (sessionId: string | undefined, taskId: string, body: unknown) =>
    call(api, 'POST', `/api/runner/tasks/${b62(taskId)}/progress`, token, body, header(sessionId));
  const pin = (sessionId: string | undefined, body: unknown) =>
    call(api, 'POST', '/api/runner/tasks/batch-pin', token, body, header(sessionId));
  const create = (sessionId: string | undefined, body: unknown) =>
    call(api, 'POST', '/api/runner/tasks', token, body, { ...header(sessionId), 'x-orbit-workspace-id': b62(workspaceId) });
  const decideAs = (sessionId: string, taskId: string, body: unknown) =>
    call(api, 'POST', `/api/runner/tasks/${b62(taskId)}/evidence/decision`, token, body, header(sessionId));
  const CONFIRM = { decision: 'CONFIRM', evidenceRevision: '1' };
  const SEND_BACK = { decision: 'SEND_BACK', evidenceRevision: '1', note: 'show the suite passing' };
  const ownerDecides = (taskId: string, decidingSessionId: string, body: Record<string, unknown>) =>
    call(api, 'POST', `/api/tasks/${b62(taskId)}/evidence/decision`, bearer, { ...body, decidingSessionId: b62(decidingSessionId) });

  /** One revision of evidence on a task, the way its run submits it. */
  const submitted = async (work: Work, on: Project | null, key = on ? on.definitionId : work.taskId) => {
    const toolUseId = `toolu_${randomUUID()}`;
    await db.toolCall.create({ data: { sessionId: work.sessionId, name: 'Bash', toolUseId, input: { command: 'npm test' }, isError: false } });
    ok(await call(api, 'POST', `/api/runner/tasks/${b62(work.taskId)}/evidence`, token, {
      evidence: { claim: 'the suite passed', criterion: { key: b62(key), text: STANDARD }, checks: [{ kind: 'TOOL_CALL', ref: toolUseId }], gaps: [] },
    }, header(work.sessionId)), 'the evidence');
    return work;
  };
  const withEvidence = async (title: string, on: Project | null, extra: Partial<Prisma.TaskUncheckedCreateInput> = {}) =>
    submitted(await workOf(title, on, extra), on);
  /** A refused decision writes no row, and leaves the task exactly as it stood. */
  const refusedDecision = async (sessionId: string, work: Work, body: unknown, code: string, what: string) => {
    const before = await stands(work.taskId);
    const reply = await decideAs(sessionId, work.taskId, body);
    assert.deepEqual([reply.status, reply.json?.code], [403, code], `${what} answered ${reply.status}: ${reply.text.slice(0, 500)}`);
    assert.equal(await decisionsOf(work.taskId), 0, `${what} wrote no decision`);
    assert.equal(await stands(work.taskId), before, `${what} left the task as it stood`);
    return reply;
  };
  const settledDecision = async (reply: Reply, work: Work, what: string) => {
    ok(reply, what);
    assert.equal((await row(work.taskId)).status, 'DONE', `${what} settled it`);
  };
  const sentBack = async (reply: Reply, work: Work, what: string) => {
    ok(reply, what);
    assert.equal(await decisionsOf(work.taskId), 1, `${what} wrote its decision`);
    assert.equal((await row(work.taskId)).status, 'IN_PROGRESS', `${what} left the task open`);
  };

  /** One criterion as the project's page reads it: whether it is met, and which clauses hold it up. */
  const criterionOf = async (on: Project, definitionId: string) => {
    const read = ok(await call(api, 'GET', `/api/projects/${b62(on.id)}`, bearer), 'the project') as {
      acceptanceCriteriaItems: Array<{ key: string; satisfied: boolean; unmet: Array<{ clause: string }> }>;
    };
    const item = read.acceptanceCriteriaItems.find((criterion) => criterion.key === b62(definitionId));
    assert.ok(item, 'the project states that criterion');
    return item;
  };

  const project = await projectOf('the project');
  const elsewhere = await projectOf('another project');

  await t.test('(1) a run may not decide another task\'s evidence', async (t) => {
    for (const [place, on] of [['a project', project], ['no project', null]] as const) {
      await t.test(`a sibling, CONFIRM and SEND_BACK, in ${place}`, async () => {
        const peer = await workOf(`a peer in ${place}`, on);
        const confirmed = await withEvidence(`to confirm, in ${place}`, on);
        const confirm = await refusedDecision(peer.sessionId, confirmed, CONFIRM, DECIDE_REFUSED, 'CONFIRM');
        refused(confirm, DECIDE_REFUSED, 'CONFIRM');
        const sent = await withEvidence(`to send back, in ${place}`, on);
        refused(await refusedDecision(peer.sessionId, sent, SEND_BACK, DECIDE_REFUSED, 'SEND_BACK'), DECIDE_REFUSED, 'SEND_BACK');
      });
    }
    await t.test('a task it filed, in a project', async () => {
      const filer = await workOf('a run that files work', project);
      const filed = await withEvidence('filed by a run, in a project', project, filedBy(filer.sessionId));
      await refusedDecision(filer.sessionId, filed, CONFIRM, DECIDE_REFUSED, 'the run that filed it');
    });
    await t.test('a verifier\'s run, on anything but what it verifies', async () => {
      const verified = await taskOf('what it verifies', project);
      const verifier = await workOf('a verifier', project, verifierExtra(verified));
      const other = await withEvidence('another subject', project);
      await refusedDecision(verifier.sessionId, other, CONFIRM, DECIDE_REFUSED, 'a verifier on another task');
    });
    await t.test('a run in no project, on a task it did not file', async () => {
      const filer = await workOf('a run that files work, in no project', null);
      const peer = await workOf('a peer in no project', null);
      const filed = await withEvidence('filed by the other run', null, filedBy(filer.sessionId));
      await refusedDecision(peer.sessionId, filed, CONFIRM, DECIDE_REFUSED, 'a run that did not file it');
    });
    await t.test('the refusals it already had come first, and still read as they did', async () => {
      const own = await withEvidence('its own task', project);
      await refusedDecision(own.sessionId, own, CONFIRM, INDEPENDENCE_REFUSED, 'its own run');
      const stranger = await workOf('a run of another project', elsewhere);
      await refusedDecision(stranger.sessionId, own, CONFIRM, ANOTHER_PROJECT_REFUSED, 'a run of another project');
    });
  });

  await t.test('(2) everybody the evidence is addressed to decides as before', async (t) => {
    await t.test('the project\'s coordinator', async () => {
      const work = await withEvidence('for the coordinator', project);
      await settledDecision(await decideAs(project.coordinator, work.taskId, CONFIRM), work, 'the coordinator\'s CONFIRM');
      const back = await withEvidence('sent back by the coordinator', project);
      await sentBack(await decideAs(project.coordinator, back.taskId, SEND_BACK), back, 'the coordinator\'s SEND_BACK');
    });
    await t.test('a judgment session', async () => {
      const judgment = await judgmentOf(project, 'a judgment session');
      const work = await withEvidence('for a judgment', project);
      await settledDecision(await decideAs(judgment, work.taskId, CONFIRM), work, 'a judgment\'s CONFIRM');
      const back = await withEvidence('sent back by a judgment', project);
      await sentBack(await decideAs(judgment, back.taskId, SEND_BACK), back, 'a judgment\'s SEND_BACK');
    });
    await t.test('a coordinating run', async () => {
      const coordinating = await workOf('a run that coordinates a project', null);
      const on = await projectOf('coordinated by a run');
      await db.project.update({ where: { id: on.id }, data: { coordinatorSessionId: coordinating.sessionId } });
      const work = await withEvidence('for a coordinating run', on);
      await settledDecision(await decideAs(coordinating.sessionId, work.taskId, CONFIRM), work, 'a coordinating run');
    });
    await t.test('the session that dispatched a task in no project, a run among them', async () => {
      const filer = await workOf('a run that files work in no project', null);
      const work = await withEvidence('filed by a run in no project', null, filedBy(filer.sessionId));
      await settledDecision(await decideAs(filer.sessionId, work.taskId, CONFIRM), work, 'the dispatching run');
      const back = await withEvidence('sent back by the dispatching run', null, filedBy(filer.sessionId));
      await sentBack(await decideAs(filer.sessionId, back.taskId, SEND_BACK), back, 'the dispatching run\'s SEND_BACK');
      const conversation = await sessionOf('a conversation that files work');
      const filed = await withEvidence('filed by a conversation', null, filedBy(conversation));
      await settledDecision(await decideAs(conversation, filed.taskId, CONFIRM), filed, 'the dispatching conversation');
    });
    await t.test('a run of a task that verifies it', async () => {
      const work = await withEvidence('verified', project);
      const verifier = await workOf('its verifier', project, verifierExtra(work.taskId));
      await settledDecision(await decideAs(verifier.sessionId, work.taskId, CONFIRM), work, 'the verifier\'s run');
    });
    await t.test('a conversation nobody\'s run opened', async () => {
      const conversation = await sessionOf('a conversation of no task');
      const work = await withEvidence('for a conversation', project);
      await settledDecision(await decideAs(conversation, work.taskId, CONFIRM), work, 'a conversation');
    });
    await t.test('the account owner in the app, whichever session the press names', async () => {
      const peer = await workOf('a peer the owner names', project);
      const named = await withEvidence('the owner names the coordinator', project);
      await settledDecision(await ownerDecides(named.taskId, project.coordinator, CONFIRM), named, 'naming the coordinator');
      const asRun = await withEvidence('the owner names a run', project);
      await settledDecision(await ownerDecides(asRun.taskId, peer.sessionId, CONFIRM), asRun, 'naming a run');
      const back = await withEvidence('the owner sends back naming a run', project);
      await sentBack(await ownerDecides(back.taskId, peer.sessionId, SEND_BACK), back, 'sending back, naming a run');
    });
    await t.test('a request carrying a session header at the app\'s door is an agent, not the owner', async () => {
      const peer = await workOf('a peer at the app\'s door', project);
      const work = await withEvidence('at the app\'s door', project);
      const reply = await call(api, 'POST', `/api/tasks/${b62(work.taskId)}/evidence/decision`, bearer, { ...CONFIRM, decidingSessionId: b62(peer.sessionId) }, header(peer.sessionId));
      assert.deepEqual([reply.status, reply.json?.code], [403, DECIDE_REFUSED], reply.text);
      assert.equal(await decisionsOf(work.taskId), 0);
    });
  });

  await t.test('(3) the pending read does not ask a run what the door would refuse it', async () => {
    const quiet = await projectOf('a project nobody is handed evidence in', false);
    const peer = await workOf('a peer reading', quiet);
    const conversation = await sessionOf('a conversation reading');
    const work = await withEvidence('waiting', quiet);
    const pendingFor = async (sessionId: string) => ok(
      await call(api, 'GET', `/api/tasks/evidence-decisions/pending?decidingSessionId=${b62(sessionId)}`, bearer),
      'the pending read',
    ) as { count: number; pending: Array<{ taskId: string }> };
    const asked = (queue: { pending: Array<{ taskId: string }> }) => queue.pending.some((pending) => pending.taskId === b62(work.taskId));
    assert.equal(asked(await pendingFor(quiet.coordinator)), true, 'the coordinator is asked');
    assert.equal(asked(await pendingFor(conversation)), true, 'a conversation of no task is asked, as it was');
    const read = await pendingFor(peer.sessionId);
    assert.equal(asked(read), false, 'a run is not asked');
    assert.equal(read.count, read.pending.length);
    const child = await sessionOf('a conversation of the peer', undefined, peer.sessionId);
    assert.equal(asked(await pendingFor(child)), false, 'nor is a conversation it opened');
    const verifier = await workOf('its verifier, reading', quiet, verifierExtra(work.taskId));
    assert.equal(asked(await pendingFor(verifier.sessionId)), true, 'a run the evidence is addressed to is asked');
  });

  await t.test('(4) a conversation a run opened answers as that run', async (t) => {
    for (const [place, on] of [['a project', project], ['no project', null]] as const) {
      await t.test(`in ${place}`, async (t) => {
        const run = await workOf(`a run in ${place}, opening a conversation`, on);
        const conversation = await sessionOf(`a conversation of a run, ${place}`, undefined, run.sessionId);
        const nested = await sessionOf(`a conversation of that conversation, ${place}`, undefined, conversation);
        const subject = await taskOf(`a subject, ${place}`, on);
        for (const [who, session] of [['the conversation', conversation], ['a conversation of it', nested]] as const) {
          await t.test(`${who}: it may not write the verification relation`, async () => {
            const sibling = await taskOf(`a sibling for ${who}, ${place}`, on);
            const before = await stands(sibling);
            refused(await patch(session, sibling, { verifiesTaskId: b62(subject), completionCriterionOverrideReason: 'asked', description: 'other instructions' }), VERIFIER_REFUSED, 'making it a verifier');
            assert.equal(await stands(sibling), before);
            const verifier = await taskOf(`a verifier for ${who}, ${place}`, on, verifierExtra(subject));
            const standing = await stands(verifier);
            refused(await patch(session, verifier, { description: 'other instructions' }), VERIFIER_REFUSED, 'rewriting it');
            refused(await patch(session, verifier, { verdict: 'PASS' }), VERIFIER_REFUSED, 'its verdict');
            refused(await pin(session, { taskIds: [b62(verifier)], model: 'pinned' }), VERIFIER_REFUSED, 'pinning it');
            assert.equal(await stands(verifier), standing);
          });
          await t.test(`${who}: it files a verifier only on a card of its own`, async () => {
            const body = {
              title: `a verifier filed by ${who}, ${place}`, completionCriterion: 'VERIFICATION', verifiesTaskId: b62(subject),
              ...(on ? { projectId: b62(on.id) } : {}),
            };
            const answer = await create(session, body);
            assert.deepEqual([answer.status, answer.json?.code], [403, CARD_REQUIRED], answer.text);
            assert.equal(await db.task.count({ where: { ownerId, title: body.title } }), 0);
            if (on) return; // Past this rule a conversation holds no scope in a project, card or not.
            await db.approval.create({
              data: { sessionId: session, toolName: 'orbit_task_create', input: body, status: 'ALLOWED', decidedById: ownerId, decidedAt: new Date() },
            });
            ok(await create(session, body), 'on its own answered card');
          });
          await t.test(`${who}: it may not decide evidence, the run's own included`, async () => {
            const sibling = await withEvidence(`a sibling's evidence for ${who}, ${place}`, on);
            await refusedDecision(session, sibling, SEND_BACK, DECIDE_REFUSED, 'a sibling\'s');
            const own = await withEvidence(`the run's own evidence for ${who}, ${place}`, on);
            const child = await sessionOf(`a conversation of the run with evidence, ${who}, ${place}`, undefined, own.sessionId);
            refused(await refusedDecision(child, own, CONFIRM, DECIDE_REFUSED, 'the run\'s own'), DECIDE_REFUSED, 'the run\'s own');
          });
          await t.test(`${who}: it may not delete, re-wire or report on another task`, async () => {
            const verifier = await taskOf(`a verifier to touch for ${who}, ${place}`, on, verifierExtra(subject));
            refused(await remove(session, verifier), DELETE_REFUSED, 'deleting a verifier');
            assert.equal(await exists(verifier), true);
            const prerequisite = await taskOf(`a prerequisite for ${who}, ${place}`, on);
            refused(await addEdge(session, verifier, prerequisite), VERIFIER_REFUSED, 'adding an edge');
            refused(await report(session, verifier, { phase: 'by a conversation' }), VERIFIER_REFUSED, 'its progress');
            assert.deepEqual(await edgesOf(verifier), []);
          });
        }
        if (on) {
          await t.test('it may not write which criterion another task serves', async () => {
            const sibling = await taskOf('a serving sibling for a conversation', on);
            refused(await patch(conversation, sibling, { criterionKey: null }), CRITERION_KEY_REFUSED, 'taking it back');
            assert.equal((await row(sibling)).criterionDefinitionId, on.definitionId);
          });
        }
        await t.test('it deletes what it filed itself, and not what the run filed', async () => {
          const its = await taskOf(`filed by the conversation, ${place}`, null, filedBy(conversation));
          ok(await remove(conversation, its), 'what it filed itself');
          const theRuns = await taskOf(`filed by the run, ${place}`, null, filedBy(run.sessionId));
          refused(await remove(conversation, theRuns), DELETE_REFUSED, 'what the run filed');
        });
        await t.test('a verifier\'s run\'s conversation answers as that run, on that run\'s own task', async () => {
          const verifier = await workOf(`a verifier's run, ${place}`, on, verifierExtra(subject));
          const child = await sessionOf(`a conversation of a verifier's run, ${place}`, undefined, verifier.sessionId);
          const own = await patch(child, verifier.taskId, { description: 'what it found so far' });
          // Past this rule, and then the scope contract's question: a conversation holds no scope in a project.
          if (on) assert.deepEqual([own.status, own.json?.code], [403, 'PROJECT_SCOPE_MISMATCH'], own.text);
          else ok(own, 'its own task');
          const other = await taskOf(`another verifier, ${place}`, on, verifierExtra(subject));
          refused(await patch(child, other, { description: 'other instructions' }), VERIFIER_REFUSED, 'another verifier');
        });
      });
    }
    await t.test('a grant is not inherited: a verifier\'s conversation does not decide what the verifier may', async () => {
      const work = await withEvidence('verified, for the conversation', project);
      const verifier = await workOf('its verifier, with a conversation', project, verifierExtra(work.taskId));
      const child = await sessionOf('a conversation of the verifier', undefined, verifier.sessionId);
      await refusedDecision(child, work, CONFIRM, DECIDE_REFUSED, 'the verifier\'s conversation');
    });
    await t.test('the conversation of a task\'s run still dispatches what it filed', async () => {
      const run = await workOf('a run opening a dispatcher', null);
      const conversation = await sessionOf('a conversation that files work, of a run', undefined, run.sessionId);
      const filed = await withEvidence('filed by a run\'s conversation', null, filedBy(conversation));
      await settledDecision(await decideAs(conversation, filed.taskId, CONFIRM), filed, 'what it dispatched');
    });
  });

  await t.test('(5) a conversation anybody else opened is as it was', async (t) => {
    const lonelySubject = await taskOf('a subject in no project, controls', null);
    const asItWas = async (conversation: string, who: string) => {
      const sibling = await taskOf(`a sibling for ${who}`, null);
      ok(await patch(conversation, sibling, { verifiesTaskId: b62(lonelySubject), completionCriterionOverrideReason: 'asked' }), `${who} attaching`);
      ok(await patch(conversation, sibling, { description: 'by a conversation' }), `${who} editing`);
      ok(await patch(conversation, sibling, { verdict: 'PASS' }), `${who} concluding`);
      const other = await taskOf(`a verifier for ${who}`, null, verifierExtra(lonelySubject));
      ok(await pin(conversation, { taskIds: [b62(other)], model: 'pinned' }), `${who} pinning`);
      const prerequisite = await taskOf(`a prerequisite for ${who}`, null);
      ok(await addEdge(conversation, other, prerequisite), `${who} adding an edge`);
      ok(await report(conversation, other, { phase: 'by a conversation' }), `${who} reporting`);
      ok(await remove(conversation, other), `${who} deleting`);
      const work = await withEvidence(`evidence for ${who}`, null);
      await settledDecision(await decideAs(conversation, work.taskId, CONFIRM), work, `${who} deciding`);
    };
    await t.test('the owner\'s conversation', async () => asItWas(await sessionOf('the owner\'s conversation'), 'the owner\'s conversation'));
    await t.test('a conversation with no task above it', async () => {
      const top = await sessionOf('a conversation at the top');
      await asItWas(await sessionOf('below a conversation', undefined, top), 'a conversation with no task above it');
    });
    await t.test('a conversation the coordinator opened', async () => {
      await asItWas(await sessionOf('below the coordinator', undefined, project.coordinator), 'a conversation the coordinator opened');
    });
    await t.test('a conversation a judgment session opened', async () => {
      await asItWas(await sessionOf('below a judgment', undefined, await judgmentOf(project, 'a judgment that opens one')), 'a conversation a judgment opened');
    });
    await t.test('a conversation a coordinating run opened', async () => {
      const coordinating = await workOf('a coordinating run that opens one', null);
      const on = await projectOf('coordinated by a run that opens one');
      await db.project.update({ where: { id: on.id }, data: { coordinatorSessionId: coordinating.sessionId } });
      await asItWas(await sessionOf('below a coordinating run', undefined, coordinating.sessionId), 'a conversation a coordinating run opened');
    });
    await t.test('a coordinator a run\'s conversation became, and what it opens', async () => {
      const run = await workOf('a run above a coordinator', null);
      const promoted = await sessionOf('a conversation that coordinates', undefined, run.sessionId);
      const on = await projectOf('coordinated by a run\'s conversation');
      await db.project.update({ where: { id: on.id }, data: { coordinatorSessionId: promoted } });
      await asItWas(promoted, 'that coordinator');
      await asItWas(await sessionOf('below that coordinator', undefined, promoted), 'what that coordinator opened');
    });
  });

  await t.test('(6) a run deletes only ordinary work it filed itself', async (t) => {
    const peer = await workOf('a peer, deleting', project);
    await t.test('nothing else', async () => {
      const subject = await taskOf('a subject', project);
      const cases: Array<[string, string]> = [
        ['a verifier', await taskOf('a verifier', project, verifierExtra(subject))],
        ['a subject, which takes its verifier with it', subject],
        ['a task somebody else filed', await taskOf('somebody else\'s', null)],
        ['a sibling somebody else filed', await taskOf('somebody else\'s, in the project', project, plainExtra)],
        ['a task it filed that serves a criterion', await taskOf('its own, serving', project, filedBy(peer.sessionId))],
        ['a verifier it filed', await taskOf('its own verifier', null, { ...verifierExtra(subject), ...filedBy(peer.sessionId) })],
        ['the task it runs', peer.taskId],
      ];
      const checked = await taskOf('its own, with a check', null, filedBy(peer.sessionId));
      await taskOf('that check', null, verifierExtra(checked));
      cases.push(['a task it filed that has a verifier', checked]);
      for (const [what, taskId] of cases) {
        refused(await remove(peer.sessionId, taskId), DELETE_REFUSED, what);
        assert.equal(await exists(taskId), true, `${what} is still there`);
      }
    });
    await t.test('a task another run filed, and a verifier deleting itself', async () => {
      const other = await workOf('another peer', project);
      const theirs = await taskOf('filed by another run', project, { ...plainExtra, ...filedBy(other.sessionId) });
      refused(await remove(peer.sessionId, theirs), DELETE_REFUSED, 'filed by another run');
      const verifier = await workOf('a verifier of its own', project, verifierExtra(peer.taskId));
      refused(await remove(verifier.sessionId, verifier.taskId), DELETE_REFUSED, 'a verifier\'s own run');
    });
    await t.test('a delete that would satisfy a criterion is refused, and the criterion stays unmet', async () => {
      const on = await projectOf('a criterion held up by one task');
      const settled = await withEvidence('settled', on);
      await settledDecision(await decideAs(on.coordinator, settled.taskId, CONFIRM), settled, 'the coordinator');
      const held = await taskOf('holding it up', on);
      const run = await workOf('a run, deleting', on, { criterionDefinitionId: on.secondDefinitionId });
      refused(await remove(run.sessionId, held), DELETE_REFUSED, 'the unfinished work');
      assert.equal((await criterionOf(on, on.definitionId)).satisfied, false);
    });
    await t.test('what it filed itself, in a project or in none', async () => {
      const inNone = await taskOf('its own, in no project', null, filedBy(peer.sessionId));
      ok(await remove(peer.sessionId, inNone), 'in no project');
      assert.equal(await exists(inNone), false);
      const inProject = await taskOf('its own, in the project', project, { ...plainExtra, ...filedBy(peer.sessionId) });
      ok(await remove(peer.sessionId, inProject), 'in the project');
      assert.equal(await exists(inProject), false);
    });
    await t.test('everybody else, and a request that names no session', async () => {
      const subject = await taskOf('a subject for the others', project);
      const judgment = await judgmentOf(project, 'a judgment, deleting');
      const conversation = await sessionOf('a conversation, deleting');
      for (const [who, send] of [
        ['the coordinator', (id: string) => remove(project.coordinator, id)],
        ['a judgment session', (id: string) => remove(judgment, id)],
        ['a conversation of no task', (id: string) => remove(conversation, id)],
        ['a request that names no session', (id: string) => remove(undefined, id)],
        ['the owner', (id: string) => call(api, 'DELETE', `/api/tasks/${b62(id)}`, bearer)],
      ] as const) {
        const verifier = await taskOf(`a verifier for ${who}`, project, verifierExtra(subject));
        ok(await send(verifier), who);
        assert.equal(await exists(verifier), false, who);
      }
    });
  });

  await t.test('(7) a run does not change what a verifier waits for', async (t) => {
    const peer = await workOf('a peer, edges', project);
    const subject = await taskOf('a subject, edges', project);
    const another = await taskOf('another prerequisite', project);
    await t.test('one edge at a time', async () => {
      const verifier = await taskOf('a verifier, edges', project, verifierExtra(subject));
      await db.taskDependency.create({ data: { taskId: verifier, dependsOnTaskId: subject } });
      refused(await removeEdge(peer.sessionId, verifier, subject), VERIFIER_REFUSED, 'taking one away');
      refused(await addEdge(peer.sessionId, verifier, another), VERIFIER_REFUSED, 'adding one');
      assert.deepEqual(await edgesOf(verifier), [{ dependsOnTaskId: subject }]);
    });
    await t.test('an ordinary sibling\'s edges are a run\'s, a sibling waiting on a verifier among them', async () => {
      const sibling = await taskOf('an ordinary sibling, edges', project);
      ok(await addEdge(peer.sessionId, sibling, another), 'adding');
      ok(await removeEdge(peer.sessionId, sibling, another), 'removing');
      const verifier = await taskOf('a verifier to wait on', project, verifierExtra(subject));
      ok(await addEdge(peer.sessionId, sibling, verifier), 'waiting on a verifier');
    });
    await t.test('a verifier\'s own run, the coordinator, a judgment session, the owner and a request that names no session', async () => {
      const own = await workOf('a verifier of its own, edges', project, verifierExtra(subject));
      ok(await addEdge(own.sessionId, own.taskId, another), 'its own run');
      const judgment = await judgmentOf(project, 'a judgment, edges');
      for (const [who, add, drop] of [
        ['the coordinator', (id: string) => addEdge(project.coordinator, id, another), (id: string) => removeEdge(project.coordinator, id, another)],
        ['a judgment session', (id: string) => addEdge(judgment, id, another), (id: string) => removeEdge(judgment, id, another)],
        ['a request that names no session', (id: string) => addEdge(undefined, id, another), (id: string) => removeEdge(undefined, id, another)],
        ['the owner', (id: string) => call(api, 'POST', `/api/tasks/${b62(id)}/dependencies`, bearer, { dependsOnTaskId: b62(another) }), (id: string) => call(api, 'DELETE', `/api/tasks/${b62(id)}/dependencies/${b62(another)}`, bearer)],
      ] as const) {
        const verifier = await taskOf(`a verifier for ${who}, edges`, project, verifierExtra(subject));
        ok(await add(verifier), `${who} adding`);
        ok(await drop(verifier), `${who} removing`);
      }
    });
    await t.test('in a batch, without the owner\'s answered card', async () => {
      const listId = randomUUID();
      await db.taskList.create({ data: { id: listId, ownerId, title: 'a list' } });
      const listed = await taskOf('a listed verifier', project, { ...verifierExtra(subject), listId });
      const ordinary = await taskOf('a listed sibling', project, { listId });
      const onVerifier = [{ op: 'add', taskId: b62(listed), dependsOnTaskId: b62(another) }];
      const cardOf = (input: Prisma.InputJsonValue, status = 'ALLOWED', decidedById: string | null = ownerId, sessionId = peer.sessionId, toolName = 'orbit_dag_change') =>
        db.approval.create({ data: { sessionId, toolName, input, status, decidedById, decidedAt: status === 'PENDING' ? null : new Date() } });

      const noCard = await applyDag(peer.sessionId, listId, onVerifier);
      assert.deepEqual([noCard.status, noCard.json?.code], [403, DAG_CARD_REQUIRED], noCard.text);
      assert.match(noCard.json.message, /Nothing was written/);
      assert.deepEqual(await edgesOf(listed), []);

      await cardOf({ listId: b62(listId), ops: onVerifier }, 'PENDING', null);
      await cardOf({ listId: b62(listId), ops: onVerifier }, 'DENIED');
      await cardOf({ listId: b62(listId), ops: [{ op: 'remove', taskId: b62(listed), dependsOnTaskId: b62(another) }] });
      await cardOf({ listId: b62(listId), ops: [{ op: 'add', taskId: b62(listed), dependsOnTaskId: b62(subject) }] });
      await cardOf({ listId: b62(listId), ops: onVerifier }, 'ALLOWED', ownerId, project.coordinator);
      await cardOf({ listId: b62(listId), ops: onVerifier }, 'ALLOWED', ownerId, peer.sessionId, 'orbit_task_batch');
      const noneCovers = await applyDag(peer.sessionId, listId, onVerifier);
      assert.deepEqual([noneCovers.status, noneCovers.json?.code], [403, DAG_CARD_REQUIRED], 'none of those covers it');

      await cardOf({ listId: b62(listId), ops: onVerifier });
      ok(await applyDag(peer.sessionId, listId, onVerifier), 'the owner\'s answered card');
      assert.deepEqual(await edgesOf(listed), [{ dependsOnTaskId: another }]);

      const onOrdinary = [{ op: 'add', taskId: b62(ordinary), dependsOnTaskId: b62(another) }];
      ok(await applyDag(peer.sessionId, listId, onOrdinary), 'an ordinary sibling needs no card here');
      const removal = [{ op: 'remove', taskId: b62(listed), dependsOnTaskId: b62(another) }];
      ok(await applyDag(project.coordinator, listId, removal), 'the coordinator needs none');
      ok(await applyDag(undefined, listId, onVerifier), 'nor does a request that names no session');
    });
  });

  await t.test('(8) a run does not report a verifier\'s progress', async (t) => {
    const peer = await workOf('a peer, progress', project);
    const subject = await taskOf('a subject, progress', project);
    const revision = async (taskId: string) => (await db.taskProgress.findUnique({ where: { taskId } }))?.revision ?? 0;
    await t.test('a report is refused, and a read is not', async () => {
      const verifier = await taskOf('a verifier, progress', project, verifierExtra(subject));
      refused(await report(peer.sessionId, verifier, { phase: 'by a peer' }), VERIFIER_REFUSED, 'a peer\'s report');
      assert.equal(await revision(verifier), 0);
      ok(await call(api, 'GET', `/api/runner/tasks/${b62(verifier)}/progress`, token, undefined, header(peer.sessionId)), 'the read');
    });
    await t.test('everybody else', async () => {
      const sibling = await taskOf('an ordinary sibling, progress', project);
      ok(await report(peer.sessionId, sibling, { phase: 'by a peer' }), 'a peer on an ordinary sibling');
      const own = await workOf('a verifier of its own, progress', project, verifierExtra(subject));
      ok(await report(own.sessionId, own.taskId, { phase: 'by its own run' }), 'a verifier\'s own run');
      const judgment = await judgmentOf(project, 'a judgment, progress');
      for (const [who, send] of [
        ['the coordinator', (id: string) => report(project.coordinator, id, { phase: 'p' })],
        ['a judgment session', (id: string) => report(judgment, id, { phase: 'p' })],
        ['a request that names no session', (id: string) => report(undefined, id, { phase: 'p' })],
        ['the owner', (id: string) => call(api, 'POST', `/api/tasks/${b62(id)}/progress`, bearer, { phase: 'p' })],
      ] as const) {
        const verifier = await taskOf(`a verifier for ${who}, progress`, project, verifierExtra(subject));
        ok(await send(verifier), who);
        assert.equal(await revision(verifier), 1, who);
      }
    });
  });

  await t.test('(9) a run does not write which criterion another task serves', async (t) => {
    /** A criterion one settled task and one open task serve, and a run of the project. */
    const heldUp = async (title: string) => {
      const on = await projectOf(title);
      const settled = await withEvidence(`settled, ${title}`, on);
      await settledDecision(await decideAs(on.coordinator, settled.taskId, CONFIRM), settled, 'the coordinator');
      const held = await taskOf(`holding it up, ${title}`, on);
      const run = await workOf(`a run, ${title}`, on, { criterionDefinitionId: on.secondDefinitionId });
      const satisfied = async () => (await criterionOf(on, on.definitionId)).satisfied;
      assert.equal(await satisfied(), false, 'held up to begin with');
      return { on, settled, held, run, satisfied };
    };
    await t.test('taking work off a criterion, moving it to another, or restating it: refused, and the criterion stays unmet', async () => {
      const f = await heldUp('taken off');
      const before = await stands(f.held);
      refused(await patch(f.run.sessionId, f.held, { criterionKey: null }), CRITERION_KEY_REFUSED, 'taking it back');
      refused(await patch(f.run.sessionId, f.held, { criterionKey: b62(f.on.secondDefinitionId) }), CRITERION_KEY_REFUSED, 'another criterion');
      refused(await patch(f.run.sessionId, f.held, { criterionKey: b62(f.on.definitionId) }), CRITERION_KEY_REFUSED, 'the same key');
      assert.equal(await stands(f.held), before);
      assert.equal(await f.satisfied(), false);
    });
    await t.test('restating the key of settled work declared against older wording: refused', async () => {
      const f = await heldUp('older wording');
      await db.task.update({ where: { id: f.held }, data: plainExtra });
      await db.projectAcceptanceCriterionDefinition.update({ where: { id: f.on.definitionId }, data: { text: `${STANDARD}, reworded` } });
      refused(await patch(f.run.sessionId, f.settled.taskId, { criterionKey: b62(f.on.definitionId) }), CRITERION_KEY_REFUSED, 'restating it');
      assert.equal(await f.satisfied(), false);
    });
    await t.test('naming a criterion nobody serves on finished work: refused', async () => {
      const on = await projectOf('a criterion nobody serves');
      const finished = await workOf('finished, and serving nothing', on, plainExtra);
      await submitted(finished, on, finished.taskId);
      await settledDecision(await decideAs(on.coordinator, finished.taskId, CONFIRM), finished, 'the coordinator');
      const run = await workOf('a run, naming it', on);
      refused(await patch(run.sessionId, finished.taskId, { criterionKey: b62(on.secondDefinitionId) }), CRITERION_KEY_REFUSED, 'naming it');
      assert.equal((await criterionOf(on, on.secondDefinitionId)).satisfied, false);
    });
    await t.test('a task\'s own run writes its own', async () => {
      const f = await heldUp('its own');
      ok(await patch(f.run.sessionId, f.run.taskId, { criterionKey: b62(f.on.definitionId) }), 'declaring another');
      assert.equal((await row(f.run.taskId)).criterionDefinitionId, f.on.definitionId);
    });
    await t.test('the coordinator, a judgment session and the owner write it', async () => {
      const f = await heldUp('by those who answer for it');
      ok(await patch(f.on.coordinator, f.held, { criterionKey: b62(f.on.secondDefinitionId) }), 'the coordinator');
      assert.equal((await row(f.held)).criterionDefinitionId, f.on.secondDefinitionId);
      const judgment = await judgmentOf(f.on, 'a judgment, criterion');
      ok(await patch(judgment, f.held, { criterionKey: b62(f.on.definitionId) }), 'a judgment session');
      assert.equal((await row(f.held)).criterionDefinitionId, f.on.definitionId);
      ok(await call(api, 'PATCH', `/api/tasks/${b62(f.held)}`, bearer, { criterionKey: null }), 'the owner');
      assert.equal((await row(f.held)).criterionDefinitionId, null);
      ok(await patch(undefined, f.held, { criterionKey: b62(f.on.definitionId) }), 'a request that names no session');
    });
    await t.test('asking to move a task is no such write: it goes to the owner, and nothing moves', async () => {
      const f = await heldUp('asking');
      const elsewhereKey = b62(elsewhere.definitionId);
      const reply = await patch(f.run.sessionId, f.held, { projectId: b62(elsewhere.id), handoff: { reason: 'it belongs there' }, criterionKey: elsewhereKey });
      assert.deepEqual([reply.status, reply.json?.code], [403, 'CROSS_PROJECT_APPROVAL_REQUIRED'], reply.text);
      const after = await row(f.held);
      assert.deepEqual([after.projectId, after.criterionDefinitionId], [f.on.id, f.on.definitionId]);
      assert.equal(await f.satisfied(), false);
    });
    await t.test('moving a task out itself stays refused for its own reasons', async () => {
      const f = await heldUp('moving out');
      const out = await patch(f.run.sessionId, f.held, { projectId: null });
      assert.deepEqual([out.status, out.json?.code], [403, 'UNMAPPED_PROJECT_WORK'], out.text);
      const away = await patch(f.run.sessionId, f.held, { projectId: b62(elsewhere.id) });
      assert.deepEqual([away.status, away.json?.code], [403, 'PROJECT_SCOPE_MISMATCH'], away.text);
      assert.equal(await f.satisfied(), false);
    });
  });

  await t.test('(10) cancelling or failing work serving a criterion does not satisfy it, and stays a run\'s to do', async () => {
    const on = await projectOf('a criterion, cancelled under');
    const settled = await withEvidence('settled, cancelled under', on);
    await settledDecision(await decideAs(on.coordinator, settled.taskId, CONFIRM), settled, 'the coordinator');
    const run = await workOf('a run, cancelling', on, { criterionDefinitionId: on.secondDefinitionId });
    const satisfied = () => criterionOf(on, on.definitionId);
    const cancelled = await taskOf('cancelled by a run', on);
    ok(await patch(run.sessionId, cancelled, { status: 'CANCELLED' }), 'a run cancelling a serving sibling');
    assert.deepEqual((await satisfied()).unmet.map((reason) => reason.clause), ['SERVING_WORK_UNSETTLED']);
    const failed = await taskOf('failed by a run', on);
    ok(await patch(run.sessionId, failed, { status: 'FAILED' }), 'a run failing a serving sibling');
    assert.equal((await satisfied()).satisfied, false);
    ok(await patch(run.sessionId, run.taskId, { status: 'FAILED' }), 'its own task\'s status');
    const peer = await workOf('another run, editing', on);
    const plain = await taskOf('a plain sibling', on, plainExtra);
    ok(await patch(peer.sessionId, plain, { title: 'renamed by a peer', status: 'CANCELLED' }), 'a plain sibling\'s fields and status');
    const serving = await taskOf('a serving sibling, edited', on);
    ok(await patch(peer.sessionId, serving, { description: 'by a peer', labels: ['peer'], priority: 3 }), 'a serving sibling\'s other fields');
  });

  await t.test('(11) a run does not write what settles another task', async (t) => {
    const WRITES: Array<[string, Record<string, unknown>]> = [
      ['completionCriterion, with a command of its choosing', { completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0, completionCriterionOverrideReason: 'asked' }],
      ['the acceptance pair alone, which moves the criterion too', { acceptanceCommand: 'true', acceptanceExpectedExitCode: 0, completionCriterionOverrideReason: 'asked' }],
      ['acceptanceExpectedExitCode', { acceptanceExpectedExitCode: 0 }],
      ['completionPolicy', { completionPolicy: 'ALL_CHILDREN_DONE' }],
      ['acceptanceCriteria', { acceptanceCriteria: 'another standard' }],
      ['acceptanceCriteria cleared', { acceptanceCriteria: null }],
      ['what it already says, restated', { completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: STANDARD }],
    ];
    const refusedStandard = async (sessionId: string, taskId: string, what: string) => {
      for (const [field, body] of WRITES) {
        const before = await stands(taskId);
        refused(await patch(sessionId, taskId, body), STANDARD_REFUSED, `${what}: ${field}`);
        assert.equal(await stands(taskId), before, `${what}: ${field} left the row as it stood`);
      }
    };
    const REDECLARE = { completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0, completionCriterionOverrideReason: 'asked' };
    const redeclared = async (taskId: string, what: string) => assert.deepEqual(
      [(await row(taskId)).completionCriterion, (await row(taskId)).acceptanceCommand], ['EXECUTABLE', 'true'], what,
    );

    for (const [place, on] of [['a project', project], ['no project', null]] as const) {
      await t.test(`nothing of it, from a run or a conversation it opened, in ${place}`, async () => {
        const run = await workOf(`a run in ${place}, rewriting`, on);
        const conversation = await sessionOf(`its conversation, ${place}, rewriting`, undefined, run.sessionId);
        const sibling = await taskOf(`a sibling in ${place}, to rewrite`, on);
        await refusedStandard(run.sessionId, sibling, 'a run');
        await refusedStandard(conversation, sibling, 'its conversation');
      });
    }
    await t.test('the message says who can make the edit', async () => {
      const run = await workOf('a run, reading the refusal', project);
      const reply = await patch(run.sessionId, await taskOf('a sibling, for the refusal', project), { acceptanceCriteria: 'another standard' });
      assert.equal(reply.json.requiredAction, 'ASK_THE_COORDINATOR_OR_THE_OWNER');
      assert.match(reply.json.message, /The account owner can make this edit, and so can the project's coordinator or a judgment session/);
      assert.match(reply.json.message, /filed itself that serves no acceptance criterion/);
    });
    await t.test('a task another session filed, or one it filed that serves a criterion', async () => {
      const run = await workOf('a run, with filings', project);
      const other = await workOf('another run, with filings', project);
      await refusedStandard(run.sessionId, await taskOf('filed by another run, serving nothing', project, { ...plainExtra, ...filedBy(other.sessionId) }), 'filed by another run');
      await refusedStandard(run.sessionId, await taskOf('filed by this run, serving a criterion', project, filedBy(run.sessionId)), 'filed by this run, serving a criterion');
      const conversation = await sessionOf('its conversation, with filings', undefined, run.sessionId);
      await refusedStandard(conversation, await taskOf('filed by the run, not by its conversation', null, filedBy(run.sessionId)), 'filed by the run it answers as');
    });
    await t.test('a task it filed itself that serves no criterion is its to restate', async () => {
      const run = await workOf('a run, restating its own filing', project);
      const inProject = await taskOf('its own filing, in the project', project, { ...plainExtra, ...filedBy(run.sessionId) });
      ok(await patch(run.sessionId, inProject, REDECLARE), 'in the project');
      await redeclared(inProject, 'in the project');
      const inNone = await taskOf('its own filing, in no project', null, filedBy(run.sessionId));
      ok(await patch(run.sessionId, inNone, { acceptanceCriteria: 'another standard' }), 'in no project');
      assert.equal((await row(inNone)).acceptanceCriteria, 'another standard');
      const conversation = await sessionOf('a conversation, restating its own filing', undefined, run.sessionId);
      const its = await taskOf('filed by the conversation', null, filedBy(conversation));
      ok(await patch(conversation, its, REDECLARE), 'a conversation, on what it filed itself');
    });
    await t.test('those who answer for the work, and a request that names no session', async () => {
      const judgment = await judgmentOf(project, 'a judgment, rewriting');
      for (const [who, send] of [
        ['the coordinator', (id: string) => patch(project.coordinator, id, REDECLARE)],
        ['a judgment session', (id: string) => patch(judgment, id, REDECLARE)],
        ['a request that names no session', (id: string) => patch(undefined, id, REDECLARE)],
        ['the owner', (id: string) => call(api, 'PATCH', `/api/tasks/${b62(id)}`, bearer, REDECLARE)],
      ] as const) {
        const sibling = await taskOf(`a sibling for ${who}, to rewrite`, project);
        ok(await send(sibling), who);
        await redeclared(sibling, who);
      }
      const conversation = await sessionOf('a conversation of no task, rewriting');
      const lonely = await taskOf('a task in no project, for a conversation', null);
      ok(await patch(conversation, lonely, REDECLARE), 'a conversation nobody\'s run opened');
      await redeclared(lonely, 'a conversation nobody\'s run opened');
    });
    await t.test('its own task keeps the refusal it had, and a conversation it opened gets the same one', async () => {
      for (const [place, on] of [['a project', project], ['no project', null]] as const) {
        const run = await workOf(`a run of its own, ${place}, rewriting`, on);
        const conversation = await sessionOf(`its conversation, ${place}, rewriting its task`, undefined, run.sessionId);
        for (const [who, session] of [['the run', run.sessionId], ['its conversation', conversation]] as const) {
          const before = await stands(run.taskId);
          const reply = await patch(session, run.taskId, REDECLARE);
          assert.deepEqual([reply.status, reply.json?.code], [403, SELF_REWRITE_REFUSED], `${who}, ${place}: ${reply.text.slice(0, 300)}`);
          assert.equal(await stands(run.taskId), before, `${who}, ${place}`);
        }
      }
    });
    await t.test('the fields that do not say what settles a task stay as they were', async () => {
      const run = await workOf('a run, editing the rest', project);
      const sibling = await taskOf('a sibling, the rest', project, { completionCriterion: 'EXECUTABLE', acceptanceCommand: 'npm test', acceptanceExpectedExitCode: 0 });
      ok(await patch(run.sessionId, sibling, { title: 'renamed', description: 'by a peer', labels: ['peer'], priority: 3, acceptanceTimeoutSeconds: 60 }), 'the rest');
      assert.equal((await row(sibling)).acceptanceTimeoutSeconds, 60);
    });
  });
});
