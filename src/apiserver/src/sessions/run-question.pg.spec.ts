import { ProjectOpenItemService } from '../projects/project-open-item.service';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { PushService } from '../push/push.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionRequestService } from './session-request.service';
import { SessionsService } from './sessions.service';
import { appendRunQuestionContext, questionAnswers, questionHolds } from './run-question';
import { countLiveApprovals } from './abandoned-approvals';

const url = process.env.COORDINATOR_PG_URL;
const input = { questions: [{ question: 'Which port?', options: [{ label: '3000' }, { label: '4000' }] }] };

test('Automatic run question reaches coordinator, answer reaches runner, same-session permission still alerts owner, and fallback is labelled', { skip: !url, timeout: 120_000 }, async () => {
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const ownerId = randomUUID();
  const pushes: unknown[][] = [];
  const frames: unknown[][] = [];
  const realtime = new Proxy({}, { get: (_, name) => name === 'publish' ? (...args: unknown[]) => frames.push(args) : () => undefined });
  const queue = new Proxy({}, { get: () => () => undefined });
  const push = { notifyApprovalRequest: async (...args: unknown[]) => { pushes.push(args); } };
  const sessions = new SessionsService(prisma, queue as never, realtime as never);
  const api = new RunnerApiController(prisma, queue as never, realtime as never, push as never, {} as never, {} as never);
  Object.assign(api, { sessions });
  const requests = new SessionRequestService(prisma, sessions, realtime as never);
  const badges = new PushService(prisma, { get: () => undefined } as never);
  try {
    await db.user.create({ data: { id: ownerId, email: `${ownerId}@question.invalid`, passwordHash: 'x', name: 'Question spec' } });
    const runner = await db.runner.create({ data: { ownerId, name: 'Runner', tokenHash: randomUUID(), status: 'ONLINE' } });
    const coordinator = await db.session.create({ data: { ownerId, creatorId: ownerId, title: 'Coordinator', prompt: 'Coordinate', provider: 'codex', status: 'AWAITING_INPUT' } });
    const project = await db.project.create({ data: { ownerId, title: 'Automatic', goal: 'Answer run', coordinatorEnabled: true, coordinatorSessionId: coordinator.id, exceptionEscalationSeconds: 300 } });
    const task = await db.task.create({ data: { ownerId, creatorId: ownerId, creatorType: 'USER', title: 'Choose port', projectId: project.id, completionCriterion: 'EVIDENCE_JUDGMENT' } });
    const run = await db.session.create({ data: { ownerId, creatorId: ownerId, title: 'Run', prompt: 'Work', provider: 'claude', taskId: task.id, assignedRunnerId: runner.id, status: 'RUNNING', engineTurnActive: true } });
    const caller = { id: runner.id, ownerId };
    async function ask() { return api.createApproval(caller, run.id, { toolName: 'AskUserQuestion', toolUseId: randomUUID(), input }); }
    const question = await ask();
    const request = await db.sessionRequest.findFirstOrThrow({ where: { approvalId: question.id } });
    assert.equal(request.kind, 'RUN_QUESTION');
    assert.equal(request.toSessionId, coordinator.id);
    const turn = await db.conversationTurn.findUniqueOrThrow({ where: { id: request.turnId } });
    assert.equal(turn.content, '');
    assert.equal(turn.senderSessionId, null);
    assert.match((await appendRunQuestionContext(db, turn.clientTurnId, ''))!, /<orbit-run-question/);
    assert.match((await appendRunQuestionContext(db, turn.clientTurnId, ''))!, /Which port/);
    assert.deepEqual(pushes, []);
    assert.equal(frames.some(args => (args[1] as { type?: string })?.type === 'approval_request'), false);
    assert.deepEqual(await badges.needsYouSessions(ownerId), []);
    assert.equal(await countLiveApprovals(db, run), 0);
    assert.deepEqual(await sessions.listApprovals(ownerId, run.id, 'PENDING'), []);

    const permission = await api.createApproval(caller, run.id, { toolName: 'Bash', input: { command: 'pwd' }, toolUseId: randomUUID() });
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0][1], permission.id);
    assert.deepEqual(await badges.needsYouSessions(ownerId), [run.id]);
    assert.equal(await countLiveApprovals(db, run), 1);
    assert.equal(await (badges as unknown as { claimApprovalAlert(s: string, a: string): Promise<boolean> }).claimApprovalAlert(run.id, permission.id), true,
      'a held question cannot swallow the security approval alert edge');
    await assert.rejects(requests.reply(ownerId, run.id, request.id, { option: 0 }), /only the session/);
    const items = new ProjectOpenItemService(prisma, sessions);
    await assert.rejects(items.askOwner(ownerId, project.id, coordinator.id, {
      question: 'Can I expose this port?', forRunQuestion: randomUUID(),
    }), /run question/i);
    const raised = await items.askOwner(ownerId, project.id, coordinator.id, {
      question: 'Which port may this run expose?', options: [{ label: '3000' }, { label: '4000' }],
      recommendedOption: 1, forRunQuestion: request.id, clientQuestionId: 'run-port',
    });
    const linked = await db.sessionRequest.findUniqueOrThrow({ where: { id: request.id } });
    assert.equal(linked.escalatedItemId, raised.itemId);
    assert.ok(linked.replyBy.getTime() > Date.now() + 29 * 86400 * 1000);
    await items.answerOpenItem(ownerId, project.id, raised.itemId, { option: 1 });
    const resumed = await db.sessionRequest.findUniqueOrThrow({ where: { id: request.id } });
    assert.ok(resumed.replyBy.getTime() < Date.now() + 301_000, 'owner answer restarts the bounded coordinator window');
    await requests.reply(ownerId, coordinator.id, request.id, { answers: [{ question: 0, option: 1 }] });
    const answer = await api.pollApproval(caller, run.id, question.id, {} as never);
    assert.equal(answer.status, 'ALLOWED');
    assert.deepEqual(answer.answers, { 'Which port?': ['4000'] });
    const stored = await db.approval.findUniqueOrThrow({ where: { id: question.id } });
    assert.equal(stored.decidedCredentialKind, 'COORDINATOR');
    assert.equal(stored.decidedById, null);
    assert.equal((await db.sessionRequest.findUniqueOrThrow({ where: { id: request.id } })).state, 'REPLIED');
    assert.equal(await db.conversationTurn.count({ where: { sessionId: run.id } }), 0, 'the blocked run reads approval polling, not a queued reply');
    await assert.rejects(requests.reply(ownerId, coordinator.id, request.id, { option: 0 }), /closed/i);

    await db.approval.update({ where: { id: permission.id }, data: { status: 'ALLOWED' } });
    const timed = await ask();
    await db.sessionRequest.updateMany({ where: { approvalId: timed.id }, data: { replyBy: new Date(Date.now() - 1000) } });
    assert.equal((await questionHolds(db, [timed.id])).get(timed.id)?.place, 'FALLBACK');
    const visible = await sessions.listApprovals(ownerId, run.id, 'PENDING');
    assert.equal(visible.find(a => a.id === timed.id)?.coordinatorFallback, 'TIMED_OUT');
    assert.deepEqual(await badges.needsYouSessions(ownerId), [run.id]);
    for (const [change, expected] of [
      [{ coordinatorSessionId: null }, 'NO_COORDINATOR'],
      [{ coordinatorSessionId: coordinator.id }, 'REVIEWER_ENDED'],
    ] as const) {
      await db.project.update({ where: { id: project.id }, data: change });
      if (expected === 'REVIEWER_ENDED') await db.session.update({ where: { id: coordinator.id }, data: { completedAt: new Date() } });
      const fallback = await ask();
      assert.equal((await db.approval.findUniqueOrThrow({ where: { id: fallback.id } })).coordinatorFallback, expected);
      assert.equal(pushes.at(-1)?.[3], true, 'fallback pushes carry the unreviewed label');
      assert.equal(await db.sessionRequest.count({ where: { approvalId: fallback.id } }), 0);
    }
    await db.project.update({ where: { id: project.id }, data: { coordinatorEnabled: false } });
    const ordinary = await ask();
    assert.equal((await db.approval.findUniqueOrThrow({ where: { id: ordinary.id } })).coordinatorFallback, null);
    assert.notEqual(pushes.at(-1)?.[3], true);
    const outside = await db.task.create({ data: { ownerId, creatorId: ownerId, creatorType: 'USER', title: 'No project', completionCriterion: 'EVIDENCE_JUDGMENT' } });
    const outsideRun = await db.session.create({ data: { ownerId, creatorId: ownerId, taskId: outside.id, title: 'Standalone run', prompt: 'Work', provider: 'claude', assignedRunnerId: runner.id, status: 'RUNNING' } });
    const standalone = await api.createApproval(caller, outsideRun.id, { toolName: 'AskUserQuestion', input });
    assert.equal((await db.approval.findUniqueOrThrow({ where: { id: standalone.id } })).coordinatorFallback, null);
    assert.notEqual(pushes.at(-1)?.[3], true);
    assert.deepEqual(questionAnswers(input, { message: '5000' }).answers, { 'Which port?': ['5000'] });
  } finally {
    await db.$disconnect();
    await sql.end();
  }
});
