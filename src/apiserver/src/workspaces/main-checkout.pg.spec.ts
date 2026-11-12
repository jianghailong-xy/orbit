/**
 * The main checkout relay on real PostgreSQL (docs/main-checkout-git-contract.md §2, §4–§7, §10).
 *
 * What is held here: the heartbeat's counts and fingerprint reach the workspace payload (Shared and Worktree alike);
 * the read goes through the runner and comes back; an action is the owner's, its target session this workspace's and
 * this runner's; one action per checkout is in flight; a repeated requestId answers the first; a request past its
 * deadline is TIMEOUT and never stays pending; a late result changes nothing the control plane decided; each outcome is
 * one system line in the initiating session — through a `notice` turn while that session is live on a capable runner,
 * as a run_event at max(seq)+1 otherwise; a commit writes no merge receipt and no landing; the managed-branch flag; and
 * an old runner's refusal.
 *
 * WHY REAL POSTGRESQL: the rules are two unique indexes (requestId per owner, one in-flight action per runner and root)
 * and compare-and-sets on the request row; a Prisma double answers whatever it was built to.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/workspaces/main-checkout.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ProjectStatus, RunStatus, RunnerStatus, type PrismaClient } from '@prisma/client';
import {
  MAIN_CHECKOUT_GIT_CAPABILITY,
  MAIN_CHECKOUT_UNSUPPORTED_CODE,
  type MainCheckoutActionResult,
  type MainCheckoutResultNotice,
  type MainCheckoutRunnerRequest,
} from '@orbit/shared';
import { Client } from 'pg';

import { sanitizeRunnerRepoHealth } from '../common/runner-repo-health';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { MainCheckoutService } from './main-checkout.service';
import { WorkspacesService } from './workspaces.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const ROOT = '/srv/repo';
const HEAD = 'a'.repeat(40);
const FINGERPRINT = `mc1:${HEAD}:${'b'.repeat(64)}`;

interface World {
  prisma: PrismaClient;
  service: MainCheckoutService;
  workspaces: WorkspacesService;
  ownerId: string;
  runnerId: string;
  /** Worktree-isolated workspace on the runner. */
  workspaceId: string;
  /** A Shared workspace on the same runner and checkout. */
  sharedWorkspaceId: string;
  /** The session the person presses buttons in (not live). */
  sessionId: string;
  /** A worktree session of the workspace, to move files into. */
  targetId: string;
}

async function world(t: { after(fn: () => unknown): void }, opts: { capable?: boolean; branch?: string } = {}): Promise<World> {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  await prisma.user.create({ data: { id: ownerId, email: `mc-${ownerId}@main-checkout.invalid`, name: 'owner', passwordHash: 'x' } });
  const workspaceId = randomUUID();
  const sharedWorkspaceId = randomUUID();
  await prisma.runner.create({
    data: {
      id: runnerId, ownerId, name: 'orbit-hpc', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      lastHeartbeatAt: new Date(),
      capabilities: opts.capable === false ? [] : [MAIN_CHECKOUT_GIT_CAPABILITY], capabilitiesReportedAt: new Date(),
      // Written by the function the heartbeat stores `repos` with, so this is the stored shape a beat leaves.
      repoHealth: sanitizeRunnerRepoHealth([
        {
          root: ROOT, state: 'dirty', branch: opts.branch ?? 'main', paths: ['src/a.ts'],
          agentIds: [workspaceId, sharedWorkspaceId],
          head: HEAD, upstream: 'origin/main', ahead: 2, behind: 0, fileCount: 3, truncated: false, fingerprint: FINGERPRINT,
        },
      ]) as never,
    },
  });
  await prisma.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'worktree', workDir: ROOT, enableWorktree: true } });
  await prisma.workspace.create({ data: { id: sharedWorkspaceId, ownerId, runnerId, name: 'shared', workDir: ROOT, enableWorktree: false } });
  const session = (over: Record<string, unknown> = {}) =>
    prisma.session.create({
      data: { ownerId, creatorId: ownerId, workspaceId, title: 'a session', prompt: 'p', status: RunStatus.SUCCEEDED, ...over },
      select: { id: true },
    });
  const sessionId = (await session({ isolationStatus: 'worktree', branch: 'orbit/session-1' })).id;
  const targetId = (await session({ title: 'Retry work', isolationStatus: 'worktree', branch: 'orbit/session-2', assignedRunnerId: runnerId })).id;
  const db = prisma as unknown as PrismaService;
  return {
    prisma, service: new MainCheckoutService(db), workspaces: new WorkspacesService(db),
    ownerId, runnerId, workspaceId, sharedWorkspaceId, sessionId, targetId,
  };
}

function commit(w: World, requestId: string = randomUUID(), over: Record<string, unknown> = {}) {
  return w.service.act(w.ownerId, w.workspaceId, {
    kind: 'commit', root: ROOT, fingerprint: FINGERPRINT, files: ['src/a.ts'], message: 'Add retry backoff',
    requestId, initiatedFromSessionId: w.sessionId, ...over,
  } as never);
}

async function lines(w: World, sessionId = w.sessionId): Promise<MainCheckoutResultNotice[]> {
  const rows = await w.prisma.runEvent.findMany({ where: { sessionId, type: 'system' }, orderBy: { seq: 'asc' } });
  return rows.map((r) => r.payload as unknown as MainCheckoutResultNotice).filter((p) => p.noticeKind === 'main-checkout-action-result');
}

async function handOut(w: World): Promise<MainCheckoutRunnerRequest[]> {
  return w.service.dispatch({ runnerId: w.runnerId, capabilities: [MAIN_CHECKOUT_GIT_CAPABILITY] });
}

function done(requestId: string, over: Partial<MainCheckoutActionResult> = {}): MainCheckoutActionResult {
  return {
    requestId, kind: 'commit', root: ROOT, status: 'done', branch: 'main', fileCount: 1,
    head: 'c'.repeat(40), subject: 'Add retry backoff', upstream: 'origin/main', finishedAt: new Date().toISOString(), ...over,
  };
}

test('the heartbeat counts and fingerprint reach both a Worktree and a Shared workspace', { skip }, async (t) => {
  const w = await world(t);
  for (const id of [w.workspaceId, w.sharedWorkspaceId]) {
    const ws = (await w.workspaces.get(w.ownerId, id)) as unknown as {
      repoHealth: Record<string, unknown>; mainCheckoutActions: boolean;
    };
    assert.equal(ws.repoHealth.state, 'dirty');
    assert.equal(ws.repoHealth.fingerprint, FINGERPRINT);
    assert.equal(ws.repoHealth.ahead, 2);
    assert.equal(ws.repoHealth.behind, 0);
    assert.equal(ws.repoHealth.fileCount, 3);
    assert.equal(ws.repoHealth.head, HEAD);
    assert.equal(ws.repoHealth.upstream, 'origin/main');
    assert.equal(ws.mainCheckoutActions, true);
  }
  const listed = (await w.workspaces.list(w.ownerId)) as unknown as Array<{ id: string; repoHealth: { fingerprint?: string } }>;
  assert.deepEqual(listed.map((x) => x.repoHealth.fingerprint), [FINGERPRINT, FINGERPRINT]);
});

test('the read goes through the runner: one snapshot request handed out once, its answer returned', { skip }, async (t) => {
  const w = await world(t);
  const reading = w.service.read(w.ownerId, w.workspaceId, ['src/a.ts']);
  let handed: MainCheckoutRunnerRequest[] = [];
  for (let i = 0; i < 100 && handed.length === 0; i++) {
    handed = await handOut(w);
    if (!handed.length) await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(handed.length, 1);
  const req = handed[0];
  assert.equal(req.op, 'snapshot');
  assert.ok(req.op === 'snapshot' && req.root === ROOT && req.diffPaths?.[0] === 'src/a.ts');
  assert.equal((await handOut(w)).length, 0, 'handed out once');
  const snapshot = {
    root: ROOT, branch: 'main', head: HEAD, state: 'dirty', upstream: 'origin/main', ahead: 2, behind: 0,
    files: [{ path: 'src/a.ts', status: 'M', contentHash: 'd'.repeat(40), additions: 1, deletions: 0 }],
    fileCount: 1, truncated: false, fingerprint: FINGERPRINT, checkedAt: new Date().toISOString(),
  };
  assert.deepEqual(
    await w.service.snapshotAnswer(w.runnerId, req.id, { snapshot: snapshot as never, diffs: [{ path: 'src/a.ts', binary: false, patch: '@@' }] }),
    { accepted: true },
  );
  const view = await reading;
  assert.equal(view.snapshot.fingerprint, FINGERPRINT);
  assert.equal(view.diffs?.[0]?.patch, '@@');
  assert.equal(view.actionsSupported, true);
  assert.equal(view.inFlight, null);
  // A second copy of the answer is accepted and stores nothing.
  assert.deepEqual(await w.service.snapshotAnswer(w.runnerId, req.id, { snapshot: snapshot as never }), { accepted: false });
  // Another runner cannot answer it.
  await assert.rejects(w.service.snapshotAnswer(randomUUID(), req.id, { snapshot: snapshot as never }), NotFoundException);
});

test('actions are the owner\'s: another owner, or another owner\'s session, is refused', { skip }, async (t) => {
  const w = await world(t);
  const other = await world(t);
  await assert.rejects(w.service.act(other.ownerId, w.workspaceId, {
    kind: 'push', root: ROOT, fingerprint: FINGERPRINT, requestId: randomUUID(),
  } as never), NotFoundException);
  await assert.rejects(w.service.read(other.ownerId, w.workspaceId), NotFoundException);
  await assert.rejects(commit(w, randomUUID(), { initiatedFromSessionId: other.sessionId }), NotFoundException);
  // A malformed request writes nothing.
  await assert.rejects(commit(w, randomUUID(), { message: '   ' }), BadRequestException);
  await assert.rejects(w.service.act(w.ownerId, w.workspaceId, {
    kind: 'push', root: ROOT, fingerprint: FINGERPRINT, files: ['x'], requestId: randomUUID(),
  } as never), BadRequestException);
  assert.equal(await w.prisma.mainCheckoutRequest.count({ where: { ownerId: { in: [w.ownerId, other.ownerId] } } }), 0);
});

test('move: the target must be a worktree session of this workspace and runner', { skip }, async (t) => {
  const w = await world(t);
  const move = (targetSessionId: string) => w.service.act(w.ownerId, w.workspaceId, {
    kind: 'move', root: ROOT, fingerprint: FINGERPRINT, files: ['src/a.ts'], targetSessionId, requestId: randomUUID(),
    initiatedFromSessionId: w.sessionId,
  } as never);
  const elsewhere = await w.prisma.session.create({
    data: { ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.sharedWorkspaceId, title: 's', prompt: 'p', isolationStatus: 'worktree', branch: 'b' },
  });
  await assert.rejects(move(elsewhere.id), /not a session of this workspace/);
  const otherRunner = await w.prisma.runner.create({ data: { ownerId: w.ownerId, name: 'other', tokenHash: `h-${randomUUID()}` } });
  const onOtherRunner = await w.prisma.session.create({
    data: { ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, title: 's', prompt: 'p', isolationStatus: 'worktree', branch: 'b', assignedRunnerId: otherRunner.id },
  });
  await assert.rejects(move(onOtherRunner.id), /another runner/);
  const shared = await w.prisma.session.create({
    data: { ownerId: w.ownerId, creatorId: w.ownerId, workspaceId: w.workspaceId, title: 's', prompt: 'p', isolationStatus: 'shared-nogit' },
  });
  await assert.rejects(move(shared.id), /no worktree/);
  await assert.rejects(move(randomUUID()), NotFoundException);
  const ok = await move(w.targetId);
  assert.equal(ok.status, 'pending');
  const [handed] = await handOut(w);
  assert.ok(handed.op === 'action' && handed.command.targetBranch === 'orbit/session-2' && handed.command.targetSessionId === w.targetId);
});

test('one action in flight per checkout: the second is ACTION_IN_FLIGHT, with its line, and its requestId keeps it', { skip }, async (t) => {
  const w = await world(t);
  const first = await commit(w);
  assert.equal(first.status, 'pending');
  const secondId = randomUUID();
  const second = await w.service.act(w.ownerId, w.workspaceId, {
    kind: 'push', root: ROOT, fingerprint: FINGERPRINT, requestId: secondId, initiatedFromSessionId: w.sessionId,
  } as never);
  assert.equal(second.status, 'finished');
  assert.equal(second.result?.code, 'ACTION_IN_FLIGHT');
  assert.equal(second.result?.status, 'refused');
  const written = await lines(w);
  assert.equal(written.length, 1);
  assert.equal(written[0].notice, 'Nothing pushed: another action on this main checkout is still running. Try again when it finishes.');
  // The same requestId again answers the same, and writes nothing more.
  assert.deepEqual((await w.service.act(w.ownerId, w.workspaceId, {
    kind: 'push', root: ROOT, fingerprint: FINGERPRINT, requestId: secondId, initiatedFromSessionId: w.sessionId,
  } as never)).result?.code, 'ACTION_IN_FLIGHT');
  assert.equal((await lines(w)).length, 1);
  // Only the first is handed to the runner.
  const handed = await handOut(w);
  assert.equal(handed.length, 1);
  assert.ok(handed[0].op === 'action' && handed[0].command.requestId === first.requestId);
});

test('a checkout the runner has not reported yet: the action is CHECKOUT_NOT_REPORTED, written as a line, never queued', { skip }, async (t) => {
  // A workspace made after its runner started: the runner's heartbeat carries no entry for it yet, but the turn that
  // just ended put a card with Move in front of the person.
  const w = await world(t);
  await w.prisma.runner.update({ where: { id: w.runnerId }, data: { repoHealth: [] as never } });
  const requestId = randomUUID();
  const move = () =>
    w.service.act(w.ownerId, w.workspaceId, {
      kind: 'move', root: ROOT, fingerprint: FINGERPRINT, files: ['src/a.ts'], targetSessionId: w.targetId,
      requestId, initiatedFromSessionId: w.sessionId,
    } as never);
  const answer = await move();
  assert.equal(answer.status, 'finished');
  assert.equal(answer.result?.code, 'CHECKOUT_NOT_REPORTED');
  assert.equal(answer.result?.status, 'refused');
  assert.equal(answer.result?.root, ROOT);
  assert.equal(answer.result?.runnerName, 'orbit-hpc');
  const written = await lines(w);
  assert.equal(written.length, 1);
  assert.equal(written[0].notice, "Nothing moved: orbit-hpc hasn't reported this main checkout yet. Try again in a minute.");
  // The same requestId again answers the same and writes nothing more; nothing is handed to the runner.
  assert.equal((await move()).result?.code, 'CHECKOUT_NOT_REPORTED');
  assert.equal((await lines(w)).length, 1);
  assert.equal((await handOut(w)).length, 0);
  // Once a heartbeat reports it, the same press goes to the runner.
  await w.prisma.runner.update({
    where: { id: w.runnerId },
    data: {
      repoHealth: sanitizeRunnerRepoHealth([
        { root: ROOT, state: 'dirty', branch: 'main', agentIds: [w.workspaceId], head: HEAD, fileCount: 1, truncated: false, fingerprint: FINGERPRINT },
      ]) as never,
    },
  });
  assert.equal((await commit(w)).status, 'pending');
  // The read still has nothing to show before then: a 404 in a sentence, not raw server text.
  await w.prisma.runner.update({ where: { id: w.runnerId }, data: { repoHealth: [] as never } });
  await assert.rejects(w.service.read(w.ownerId, w.workspaceId), (e: unknown) =>
    e instanceof NotFoundException && /hasn't reported its main checkout yet/.test(e.message));
});

test('a repeated requestId answers the first request, before and after its result', { skip }, async (t) => {
  const w = await world(t);
  const requestId = randomUUID();
  assert.deepEqual(await commit(w, requestId), { requestId, status: 'pending' });
  assert.deepEqual(await commit(w, requestId, { message: 'something else entirely' }), { requestId, status: 'pending' });
  assert.equal(await w.prisma.mainCheckoutRequest.count({ where: { ownerId: w.ownerId } }), 1);
  const [handed] = await handOut(w);
  await w.service.actionResult(w.runnerId, handed.id, done(requestId));
  const again = await commit(w, requestId);
  assert.equal(again.status, 'finished');
  assert.equal(again.result?.head, 'c'.repeat(40));
  // The same requestId from another workspace of the owner is not the same request.
  await assert.rejects(w.service.act(w.ownerId, w.sharedWorkspaceId, {
    kind: 'commit', root: ROOT, fingerprint: FINGERPRINT, files: ['src/a.ts'], message: 'm', requestId,
  } as never), ConflictException);
});

test('past its deadline an action is TIMEOUT — never left pending — and is not handed out', { skip }, async (t) => {
  const w = await world(t);
  const claimed = await commit(w);
  const [handed] = await handOut(w);
  // A queued one too: on another root, so it is not refused as in flight.
  await w.prisma.mainCheckoutRequest.create({
    data: {
      ownerId: w.ownerId, workspaceId: w.workspaceId, runnerId: w.runnerId, root: '/srv/other', op: 'action', kind: 'push',
      requestId: randomUUID(), input: {}, expiresAt: new Date(Date.now() + 300_000), initiatedFromSessionId: w.sessionId,
    },
  });
  const later = new Date(Date.now() + 301_000);
  assert.equal(await w.service.expire({ runnerId: w.runnerId, now: later }), 2);
  const rows = await w.prisma.mainCheckoutRequest.findMany({ where: { ownerId: w.ownerId } });
  assert.ok(rows.every((r) => r.state === 'finished'));
  assert.ok(rows.every((r) => (r.result as { code?: string }).code === 'TIMEOUT'));
  const timeoutLine = (await lines(w)).find((l) => l.result.requestId === claimed.requestId);
  assert.ok(timeoutLine);
  assert.match(timeoutLine.notice, /^Timed out: orbit-hpc didn't answer within 5 min, so Orbit stopped waiting\./);
  assert.equal((await handOut(w)).length, 0);
  assert.equal(handed.op, 'action');
  // A sweep again finds nothing.
  assert.equal(await w.service.expire({ runnerId: w.runnerId, now: later }), 0);
});

test('a late result never replaces TIMEOUT; it is kept and written once as its own line', { skip }, async (t) => {
  const w = await world(t);
  const { requestId } = await commit(w);
  const [handed] = await handOut(w);
  await w.service.expire({ runnerId: w.runnerId, now: new Date(Date.now() + 301_000) });
  assert.equal((await lines(w)).length, 1);
  assert.deepEqual(await w.service.actionResult(w.runnerId, handed.id, done(requestId)), { accepted: false });
  assert.deepEqual(await w.service.actionResult(w.runnerId, handed.id, done(requestId)), { accepted: false });
  const row = await w.prisma.mainCheckoutRequest.findFirstOrThrow({ where: { requestId } });
  assert.equal((row.result as { code?: string }).code, 'TIMEOUT');
  assert.equal((row.lateResult as { status?: string }).status, 'done');
  const written = await lines(w);
  assert.equal(written.length, 2, 'the TIMEOUT line and the late result, once');
  assert.match(written[1].notice, /^Committed 1 file to main in the main checkout as ccccccc/);
  assert.equal((await commit(w, requestId)).result?.code, 'TIMEOUT');
  // A repeat of the runner's own result is ignored as well.
  const second = await commit(w);
  const [h2] = await handOut(w);
  assert.deepEqual(await w.service.actionResult(w.runnerId, h2.id, done(second.requestId)), { accepted: true });
  assert.deepEqual(await w.service.actionResult(w.runnerId, h2.id, done(second.requestId, { head: 'e'.repeat(40) })), { accepted: false });
  const kept = await w.prisma.mainCheckoutRequest.findFirstOrThrow({ where: { requestId: second.requestId } });
  assert.equal((kept.result as { head?: string }).head, 'c'.repeat(40));
  assert.equal(kept.lateResult, null);
  assert.equal((await lines(w)).length, 3);
});

test('a result is a system line in the initiating session: a run_event at max(seq)+1 when it is not live', { skip }, async (t) => {
  const w = await world(t);
  await w.prisma.runEvent.createMany({
    data: [1, 2, 3].map((seq) => ({ sessionId: w.sessionId, seq, type: 'assistant', payload: { text: `${seq}` } })),
  });
  const { requestId } = await commit(w);
  const [handed] = await handOut(w);
  await w.service.actionResult(w.runnerId, handed.id, {
    ...done(requestId), status: 'refused', code: 'FINGERPRINT_STALE', paths: ['src/api/retry.ts'],
  } as MainCheckoutActionResult);
  const events = await w.prisma.runEvent.findMany({ where: { sessionId: w.sessionId }, orderBy: { seq: 'asc' } });
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4]);
  const line = events[3].payload as unknown as MainCheckoutResultNotice;
  assert.equal(events[3].type, 'system');
  assert.equal(events[3].turnId, null);
  assert.equal(line.noticeKind, 'main-checkout-action-result');
  assert.equal(line.notice, 'Nothing committed: the main checkout changed since you looked (src/api/retry.ts).');
  assert.equal(line.result.code, 'FINGERPRINT_STALE');
  assert.equal(await w.prisma.conversationTurn.count({ where: { sessionId: w.sessionId, kind: 'notice' } }), 0);
});

test('a runner\'s ACTION_FAILED is accepted and written as its line; a control-plane code from the runner is not', { skip }, async (t) => {
  const w = await world(t);
  const { requestId } = await commit(w);
  const [handed] = await handOut(w);
  await assert.rejects(
    w.service.actionResult(w.runnerId, handed.id, { ...done(requestId), status: 'refused', code: 'TIMEOUT' } as MainCheckoutActionResult),
    BadRequestException,
  );
  await w.service.actionResult(w.runnerId, handed.id, {
    ...done(requestId), status: 'refused', code: 'ACTION_FAILED', gitMessage: 'no email was given and auto-detection is disabled',
  } as MainCheckoutActionResult);
  const [line] = await lines(w);
  assert.equal(line.result.code, 'ACTION_FAILED');
  assert.equal(
    line.notice,
    'Nothing committed: git couldn\'t commit (“no email was given and auto-detection is disabled”). The main checkout was left as it was.',
  );
  const answer = await commit(w, requestId);
  assert.equal(answer.result?.code, 'ACTION_FAILED');
});

test('a live session on a capable runner gets the line as a `notice` turn for the runner to number', { skip }, async (t) => {
  const w = await world(t);
  await w.prisma.session.update({ where: { id: w.sessionId }, data: { status: RunStatus.AWAITING_INPUT, assignedRunnerId: w.runnerId } });
  await w.prisma.runEvent.create({ data: { sessionId: w.sessionId, seq: 1, type: 'assistant', payload: { text: 'hi' } } });
  const { requestId } = await commit(w);
  const [handed] = await handOut(w);
  await w.service.actionResult(w.runnerId, handed.id, done(requestId));
  // Nothing written into run_event, where it would take the seq the runner is about to use.
  assert.equal(await w.prisma.runEvent.count({ where: { sessionId: w.sessionId } }), 1);
  const turns = await w.prisma.conversationTurn.findMany({ where: { sessionId: w.sessionId, kind: 'notice' } });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, 'PENDING');
  assert.match(turns[0].clientTurnId, /^main-checkout:v1:/);
  const payload = JSON.parse(turns[0].content!) as MainCheckoutResultNotice;
  assert.equal(payload.noticeKind, 'main-checkout-action-result');
  assert.match(payload.notice, /^Committed 1 file to main in the main checkout as ccccccc “Add retry backoff”\. Not pushed yet\. This session's branch is unchanged\.$/);
  // The same session on a runner without the capability is written directly: that runner would not know the kind.
  await w.prisma.runner.update({ where: { id: w.runnerId }, data: { capabilities: [] } });
  await w.prisma.runner.update({ where: { id: w.runnerId }, data: { capabilities: [MAIN_CHECKOUT_GIT_CAPABILITY] } });
  const other = await w.prisma.runner.create({ data: { ownerId: w.ownerId, name: 'old', tokenHash: `h-${randomUUID()}`, capabilities: [] } });
  await w.prisma.session.update({ where: { id: w.sessionId }, data: { assignedRunnerId: other.id } });
  const second = await commit(w);
  const [h2] = await handOut(w);
  await w.service.actionResult(w.runnerId, h2.id, done(second.requestId));
  assert.equal(await w.prisma.conversationTurn.count({ where: { sessionId: w.sessionId, kind: 'notice' } }), 1);
  assert.deepEqual((await w.prisma.runEvent.findMany({ where: { sessionId: w.sessionId }, orderBy: { seq: 'asc' } })).map((e) => e.seq), [1, 2]);
});

test('a commit writes no merge receipt and no landing', { skip }, async (t) => {
  const w = await world(t);
  const count = () => Promise.all([
    w.prisma.sessionMergeReceipt.count(),
    w.prisma.projectLanding.count(),
    w.prisma.projectIntegrationJob.count(),
  ]);
  const before = await count();
  const { requestId } = await commit(w);
  const [handed] = await handOut(w);
  await w.service.actionResult(w.runnerId, handed.id, done(requestId));
  assert.deepEqual(await count(), before);
  const session = await w.prisma.session.findUniqueOrThrow({ where: { id: w.sessionId }, select: { mergeStatus: true } });
  assert.equal(session.mergeStatus, null);
});

test('the managed-branch flag: a project\'s integration line, its landing target, or nothing', { skip }, async (t) => {
  const w = await world(t, { capable: false, branch: 'project/abc' });
  const projectId = (await w.prisma.project.create({
    data: { ownerId: w.ownerId, title: 'Retry backoff', coordinatorWorkspaceId: w.workspaceId, status: ProjectStatus.OPEN },
  })).id;
  await w.prisma.projectCodebase.create({
    data: {
      projectId, ownerId: w.ownerId, canonicalRepoUrl: 'https://github.com/orbit/repo', upstreamRef: 'refs/heads/main',
      integrationRef: 'refs/heads/project/abc', refAuthority: 'REMOTE',
    },
  });
  // Old runner: the read is answered from the heartbeat, and carries the flag.
  const view = await w.service.read(w.ownerId, w.workspaceId);
  assert.equal(view.actionsSupported, false);
  assert.equal(view.snapshot.fingerprint, FINGERPRINT);
  assert.equal(view.snapshot.ahead, 2);
  assert.deepEqual(view.managedBranch, { projectId, projectTitle: 'Retry backoff', role: 'integration-line' });
  assert.deepEqual(await w.service.managedBranch(w.ownerId, w.workspaceId, 'main'),
    { projectId, projectTitle: 'Retry backoff', role: 'landing-target' });
  assert.equal(await w.service.managedBranch(w.ownerId, w.workspaceId, 'feature/x'), null);
  // Not tied to this workspace: no flag.
  assert.equal(await w.service.managedBranch(w.ownerId, w.sharedWorkspaceId, 'project/abc'), null);
  // A settled project lands nothing any more.
  await w.prisma.project.update({ where: { id: projectId }, data: { status: ProjectStatus.DONE } });
  assert.equal(await w.service.managedBranch(w.ownerId, w.workspaceId, 'project/abc'), null);
});

test('an old runner: actions refused with MAIN_CHECKOUT_UNSUPPORTED, nothing queued, the read still works', { skip }, async (t) => {
  const w = await world(t, { capable: false });
  await assert.rejects(commit(w), (error: unknown) => {
    assert.ok(error instanceof ConflictException);
    assert.equal((error.getResponse() as { code?: string }).code, MAIN_CHECKOUT_UNSUPPORTED_CODE);
    return true;
  });
  assert.equal(await w.prisma.mainCheckoutRequest.count({ where: { ownerId: w.ownerId } }), 0);
  const view = await w.service.read(w.ownerId, w.workspaceId);
  assert.equal(view.actionsSupported, false);
  assert.equal(view.snapshot.root, ROOT);
  assert.equal(view.snapshot.fileCount, 3);
  const ws = (await w.workspaces.get(w.ownerId, w.workspaceId)) as unknown as { mainCheckoutActions: boolean };
  assert.equal(ws.mainCheckoutActions, false);
  // Nor does a heartbeat without the capability hand anything out.
  assert.deepEqual(await w.service.dispatch({ runnerId: w.runnerId, capabilities: [] }), []);
});

test('an offline runner: the action waits with a RUNNER_OFFLINE line, and Cancel ends it before it is handed out', { skip }, async (t) => {
  const w = await world(t);
  await w.prisma.runner.update({ where: { id: w.runnerId }, data: { lastHeartbeatAt: new Date(Date.now() - 3 * 60_000) } });
  const { requestId } = await commit(w);
  let written = await lines(w);
  assert.equal(written.length, 1);
  assert.equal(written[0].result.status, 'waiting');
  assert.match(written[0].notice, /^Waiting for the runner — orbit-hpc hasn't checked in for 3 min\./);
  const cancelled = await w.service.cancel(w.ownerId, w.workspaceId, requestId);
  assert.equal(cancelled.result?.code, 'CANCELLED');
  written = await lines(w);
  assert.equal(written.at(-1)?.notice, 'Cancelled: nothing was changed.');
  assert.equal((await handOut(w)).length, 0);
});
