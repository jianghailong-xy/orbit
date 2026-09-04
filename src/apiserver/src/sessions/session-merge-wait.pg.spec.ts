/**
 * `session_merge`'s synchronous form, against a real PostgreSQL and a real git repository.
 *
 * The defect this exists for is a SHAPE, not a bug. `{ ok: true }` has always meant "queued", and
 * the outcome has always been one `merge_receipts` call away — but a caller who does not already
 * know that second tool exists reads `ok: true` as "merged". On 2026-09-04 a coordinator asked
 * twice to merge a branch that conflicts, was told `ok: true` twice, concluded the tool had
 * swallowed the failure, and went off to re-derive the conflict with `git merge-tree`. The result,
 * both conflicting paths and git's own message were sitting in a receipt the whole time.
 *
 * So: with `waitSeconds` the answer waits for the outcome and carries it, in the receipt shape
 * `merge_receipts` already serves rather than a second spelling of it — and NO waiting call, in any
 * case, ever comes back as a bare `ok: true` again. Without `waitSeconds` nothing changed at all,
 * which the last test here holds to the byte, because the Merge button is that caller.
 *
 * The git repository is real because one assertion cannot be made against invented SHAs: that the
 * `targetShaAfter` handed back is the target branch's actual new tip. The fixture merges the way
 * the runner merges — rebase the branch onto the target, fast-forward the target onto the result —
 * and the receipt reports what git actually produced.
 *
 * Destructive: it truncates. It refuses to run anywhere but the disposable server the guard in
 * coordinator-pg-test-safety identifies.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { MergeReceiptService } from './merge-receipt.service';
import { SessionsService } from './sessions.service';
import { prismaClientFor } from '../prisma/prisma-client';

const URL = process.env.COORDINATOR_PG_URL;

const BRANCH = 'orbit/merge-wait';
const TARGET = 'main';

interface World {
  ownerId: string;
  sessionId: string;
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@pccmw.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: `${label}-runner`, tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-agent`, enabled: true },
  });
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId,
      title: label, prompt: 'p', status: RunStatus.SUCCEEDED,
      branch: BRANCH, isolationStatus: 'worktree', assignedRunnerId: runnerId,
    },
  });
  return { ownerId, sessionId };
}

async function emptyWorld(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`
    TRUNCATE "session_merge_receipt", "session", "workspace", "runner", "user"
    RESTART IDENTITY CASCADE
  `);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.email=merge-wait@pcc.invalid', '-c', 'user.name=merge wait', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8' },
  ).trim();
}

/** One commit writing all of `files`. One commit and not one per file, because a rebase stops at
 *  the FIRST commit that conflicts: two commits would have git name one conflicting path and go
 *  quiet about the second, which is not the case worth testing. */
function commit(dir: string, files: string[], body: string, message: string): string {
  for (const file of files) writeFileSync(path.join(dir, file), body);
  git(dir, 'add', ...files);
  git(dir, 'commit', '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

/**
 * A repository with a branch to merge and a target that has moved on since it forked, so the merge
 * is a real replay onto a moved base rather than a fast-forward of an untouched target.
 *
 * Which files each side writes is what decides the outcome, and it is decided here rather than
 * asserted later: touching different files replays cleanly, and touching the same file on the same
 * line is how the conflict case gets its conflicting paths out of git instead of out of a fixture
 * author's imagination.
 */
function repository(branchFiles: string[], targetFiles: string[]): {
  dir: string;
  sourceSha: string;
  targetShaBefore: string;
} {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orbit-merge-wait-'));
  git(dir, 'init', '-q', '-b', TARGET);
  commit(dir, ['README.md'], 'base\n', 'base');

  git(dir, 'checkout', '-q', '-b', BRANCH);
  const sourceSha = commit(dir, branchFiles, 'from the branch\n', 'the work this session did');

  git(dir, 'checkout', '-q', TARGET);
  const targetShaBefore = commit(dir, targetFiles, 'from the target\n', 'what the target did meanwhile');
  return { dir, sourceSha, targetShaBefore };
}

/** Merge the way the runner does: replay the branch onto the target, then fast-forward the target
 *  onto the result. Returns what git produced — the new target tip, or the conflicting paths. */
function replay(dir: string): { mergedSha: string | null; conflicts: string[] } {
  git(dir, 'checkout', '-q', '-B', 'orbit/merge-wait-replay', BRANCH);
  try {
    git(dir, 'rebase', TARGET);
  } catch {
    const conflicts = git(dir, 'diff', '--name-only', '--diff-filter=U')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    git(dir, 'rebase', '--abort');
    git(dir, 'checkout', '-q', TARGET);
    return { mergedSha: null, conflicts };
  }
  const replayed = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', TARGET);
  git(dir, 'merge', '--ff-only', replayed);
  return { mergedSha: git(dir, 'rev-parse', TARGET), conflicts: [] };
}

/**
 * The runner reporting an outcome, written the way `runner-api.controller.ts#mergeResult` writes
 * it: the session projection and the receipt in ONE transaction, with the operation id echoed onto
 * the receipt's `detail`. The wait has nothing else to read, so a fixture that wrote them
 * separately would be testing a state the real path never produces.
 */
async function reportMergeResult(
  db: PrismaClient,
  w: World,
  outcome: {
    status: 'merged' | 'conflict';
    operationId: string;
    sourceSha: string;
    targetShaBefore: string;
    mergedSha?: string | null;
    conflicts?: string[];
    message?: string;
  },
): Promise<void> {
  const merged = outcome.status === 'merged';
  await db.$transaction(async (tx) => {
    await tx.session.update({
      where: { id: w.sessionId },
      data: {
        mergeStatus: outcome.status,
        mergeError: merged ? null : (outcome.message ?? null),
        mergedAt: merged ? new Date() : null,
        ...(merged ? { branchMerged: true, mergedSourceSha: outcome.sourceSha } : {}),
      },
    });
    await MergeReceiptService.fromRunnerMergeResult(tx, {
      ownerId: w.ownerId,
      sessionId: w.sessionId,
      taskId: null,
      projectId: null,
      result: merged ? 'MERGED' : 'CONFLICT',
      sourceBranch: BRANCH,
      sourceSha: outcome.sourceSha,
      targetBranch: TARGET,
      targetShaBefore: outcome.targetShaBefore,
      targetShaAfter: merged ? (outcome.mergedSha ?? null) : null,
      rebaseBaseSha: outcome.targetShaBefore,
      conflicts: outcome.conflicts ?? [],
      message: outcome.message ?? null,
      operationId: outcome.operationId,
    });
  });
}

/** The operation id the queueing transaction minted, once it has committed. The waiting call
 *  queues before it starts polling, so this is how the fixture stands in for the heartbeat that
 *  would deliver the command — without racing the commit that creates it. */
async function queuedOperationId(db: PrismaClient, sessionId: string): Promise<string> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const session = await db.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { mergeStatus: true, mergeOperationId: true },
    });
    if (session.mergeStatus === 'pending' && session.mergeOperationId) return session.mergeOperationId;
    await delay(25);
  }
  throw new Error('the merge was never queued');
}

const suite = URL ? test : test.skip;

suite('session_merge, asked to wait for the outcome, on real PostgreSQL', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  const db = prismaClientFor(URL);
  const service = new SessionsService(db as unknown as PrismaService, {} as never, {} as never);
  const repositories: string[] = [];
  t.after(async () => {
    for (const dir of repositories) rmSync(dir, { recursive: true, force: true });
    await db.$disconnect();
    await client.end();
  });

  await t.test('a merge that lands comes back inline, and its targetShaAfter IS the new tip', async () => {
    await emptyWorld(client);
    const w = await world(db, 'landed');
    // Different files on each side, so this replays cleanly onto a target that has moved.
    const repo = repository(['branch-only.txt'], ['target-only.txt']);
    repositories.push(repo.dir);

    const waiting = service.mergeToMain(w.ownerId, w.sessionId, TARGET, 30);
    const operationId = await queuedOperationId(db, w.sessionId);
    const outcome = replay(repo.dir);
    assert.equal(outcome.conflicts.length, 0, 'this fixture is supposed to merge cleanly');
    await reportMergeResult(db, w, {
      status: 'merged',
      operationId,
      sourceSha: repo.sourceSha,
      targetShaBefore: repo.targetShaBefore,
      mergedSha: outcome.mergedSha,
    });

    const answer = (await waiting) as Record<string, any>;
    assert.equal(answer.outcome, 'SETTLED');
    assert.equal(answer.operationId, operationId);
    // The receipt itself, in merge_receipts' shape — not a second set of fields describing it.
    assert.equal(answer.receipt.result, 'MERGED');
    assert.equal(answer.receipt.landed, true);
    assert.equal(answer.receiptAbsentReason, null);
    assert.equal(answer.receipt.sourceSha, repo.sourceSha);
    assert.equal(answer.receipt.targetBranch, TARGET);
    assert.equal(answer.receipt.targetShaAfter, outcome.mergedSha);
    // The assertion the invented-SHA version of this test could not make.
    assert.equal(answer.receipt.targetShaAfter, git(repo.dir, 'rev-parse', TARGET));
    assert.notEqual(answer.receipt.targetShaAfter, repo.targetShaBefore);
    assert.deepEqual(answer.receipt.conflicts, []);
  });

  await t.test('a merge that conflicts comes back inline, with every path, and never as ok: true', async () => {
    await emptyWorld(client);
    const w = await world(db, 'conflict');
    // The same two files on both sides, same line: git decides these conflict, not this fixture.
    const repo = repository(['tasks.ts', 'App.tsx'], ['tasks.ts', 'App.tsx']);
    repositories.push(repo.dir);

    const waiting = service.mergeToMain(w.ownerId, w.sessionId, TARGET, 30);
    const operationId = await queuedOperationId(db, w.sessionId);
    const outcome = replay(repo.dir);
    assert.equal(outcome.mergedSha, null, 'this fixture is supposed to conflict');
    assert.ok(outcome.conflicts.length > 0, 'git has to have named the conflicting paths');
    await reportMergeResult(db, w, {
      status: 'conflict',
      operationId,
      sourceSha: repo.sourceSha,
      targetShaBefore: repo.targetShaBefore,
      conflicts: outcome.conflicts,
      message: 'CONFLICT (content): Merge conflict in tasks.ts',
    });

    const answer = (await waiting) as Record<string, any>;
    assert.equal(answer.outcome, 'SETTLED');
    assert.equal(answer.receipt.result, 'CONFLICT');
    assert.equal(answer.receipt.landed, false);
    assert.equal(answer.receipt.targetShaAfter, null);
    // Every path git reported, by name — the whole of what the caller had to go and re-derive.
    assert.deepEqual([...answer.receipt.conflicts].sort(), [...outcome.conflicts].sort());
    assert.deepEqual(answer.receipt.conflicts.slice().sort(), ['App.tsx', 'tasks.ts']);
    assert.match(String(answer.receipt.detail.message), /CONFLICT/);
    // THE point of this whole task: a failure is never dressed as `{ ok: true }`.
    assertNoBareOk(answer);

    // And now the thing that actually happened: asked AGAIN, because the first answer had said
    // nothing. The second attempt conflicts identically, so MR4's key makes the runner's report a
    // no-op — no second row — and a wait that only knew how to look up its own operation id would
    // have to answer "settled, with no receipt" while the receipt describing that very conflict sat
    // one row away. It answers with the conflict instead.
    const asked = service.mergeToMain(w.ownerId, w.sessionId, TARGET, 30);
    const secondOperationId = await queuedOperationId(db, w.sessionId);
    assert.notEqual(secondOperationId, operationId);
    await reportMergeResult(db, w, {
      status: 'conflict',
      operationId: secondOperationId,
      sourceSha: repo.sourceSha,
      targetShaBefore: repo.targetShaBefore,
      conflicts: outcome.conflicts,
      message: 'CONFLICT (content): Merge conflict in tasks.ts',
    });

    const second = (await asked) as Record<string, any>;
    assert.equal(second.outcome, 'SETTLED');
    assert.equal(second.receipt.result, 'CONFLICT');
    assert.deepEqual(second.receipt.conflicts.slice().sort(), ['App.tsx', 'tasks.ts']);
    // The same receipt, because it is the same merge: one conflict, recorded once.
    assert.equal(second.receipt.id, answer.receipt.id);
    assertNoBareOk(second);
    const recorded = await db.sessionMergeReceipt.findMany({ where: { sessionId: w.sessionId } });
    assert.equal(recorded.length, 1);
  });

  await t.test('a wait that runs out says it has no outcome, and points at merge_receipts', async () => {
    await emptyWorld(client);
    const w = await world(db, 'timeout');

    const started = Date.now();
    // Nothing reports: this is a runner that has not reached its next heartbeat, which is the
    // ordinary case for any wait shorter than 30 seconds.
    const answer = (await service.mergeToMain(w.ownerId, w.sessionId, TARGET, 1)) as Record<string, any>;
    assert.ok(Date.now() - started >= 1000, 'it has to actually have waited the second it was given');

    assert.equal(answer.outcome, 'TIMED_OUT');
    assert.equal(answer.receipt, null);
    // The shape says it has no conclusion, rather than leaving the caller to infer one.
    assert.equal(answer.receiptAbsentReason, 'MERGE_STILL_RUNNING');
    assert.equal(answer.mergeStatus, 'pending');
    const queued = await db.session.findUniqueOrThrow({ where: { id: w.sessionId } });
    assert.equal(answer.operationId, queued.mergeOperationId);
    // Where to look, and what to look for, in the answer itself.
    assert.match(String(answer.nextStep), /merge_receipts/);
    assert.ok(String(answer.nextStep).includes(String(queued.mergeOperationId)));
    assert.match(String(answer.nextStep), /heartbeat/);
    assertNoBareOk(answer);
  });

  await t.test('without the parameter the answer is what it has always been', async () => {
    await emptyWorld(client);
    const w = await world(db, 'default');

    const answer = await service.mergeToMain(w.ownerId, w.sessionId, TARGET);

    // Byte for byte: the Merge button queues and watches the realtime stream, and this is the
    // reply it has always read. Nothing about the asynchronous path may move because a second,
    // opt-in one was added beside it.
    assert.deepEqual(answer, { ok: true });
    const queued = await db.session.findUniqueOrThrow({ where: { id: w.sessionId } });
    assert.equal(queued.mergeStatus, 'pending');
    assert.equal(queued.mergeTarget, TARGET);
    assert.ok(queued.mergeOperationId);
    assert.equal(queued.mergeOperationOwner, null);

    // And the advertised bounds are the server's, not just the tool description's.
    await assert.rejects(
      () => service.mergeToMain(w.ownerId, w.sessionId, TARGET, 0),
      /waitSeconds must be a whole number of seconds from 1 to 300/,
    );
    await assert.rejects(
      () => service.mergeToMain(w.ownerId, w.sessionId, TARGET, 301),
      /waitSeconds must be a whole number of seconds from 1 to 300/,
    );
  });

  await t.test('waiting on a merge already in flight waits for THAT one, and queues nothing', async () => {
    await emptyWorld(client);
    const w = await world(db, 'idempotent');
    const repo = repository(['branch-only.txt'], ['target-only.txt']);
    repositories.push(repo.dir);

    // The asynchronous call queues the operation...
    assert.deepEqual(await service.mergeToMain(w.ownerId, w.sessionId, TARGET), { ok: true });
    const queued = await db.session.findUniqueOrThrow({ where: { id: w.sessionId } });
    const operationId = queued.mergeOperationId;

    // ...and a waiting call joins it rather than starting a second merge of the same branch.
    const waiting = service.mergeToMain(w.ownerId, w.sessionId, TARGET, 30);
    await delay(100);
    const during = await db.session.findUniqueOrThrow({ where: { id: w.sessionId } });
    assert.equal(during.mergeOperationId, operationId);
    assert.deepEqual(during.mergeRequestedAt, queued.mergeRequestedAt);

    const outcome = replay(repo.dir);
    await reportMergeResult(db, w, {
      status: 'merged',
      operationId: operationId as string,
      sourceSha: repo.sourceSha,
      targetShaBefore: repo.targetShaBefore,
      mergedSha: outcome.mergedSha,
    });

    const answer = (await waiting) as Record<string, any>;
    assert.equal(answer.outcome, 'SETTLED');
    assert.equal(answer.operationId, operationId);
    assert.equal(answer.receipt.landed, true);
    // One merge happened, so there is one receipt: waiting is not a second request.
    const receipts = await db.sessionMergeReceipt.findMany({ where: { sessionId: w.sessionId } });
    assert.equal(receipts.length, 1);
  });
});

/** Every waiting answer, whatever happened, in the one shape that cannot be mistaken for a
 *  success. `{ ok: true }` is the shape that sent a coordinator chasing a conflict it had already
 *  been told about, so it may not come back from a call that asked to wait — not on conflict, and
 *  not on a wait that ran out either. */
function assertNoBareOk(answer: Record<string, unknown>): void {
  assert.equal('ok' in answer, false, `a waiting merge must not answer with ok: ${JSON.stringify(answer)}`);
  assert.notDeepEqual(answer, { ok: true });
  assert.ok(answer.outcome === 'SETTLED' || answer.outcome === 'TIMED_OUT');
}

/**
 * The two agent-facing doors have to name the parameter, or it is a field only an HTTP client has.
 *
 * `TestCLICapabilitiesCoverEveryMCPToolAndParameter` in `src/runner-go` is what enforces the
 * one-to-one mapping mechanically; this reads the same two hand-written lists from here, so the API
 * round that gates this work fails too if the MCP schema and the CLI drift apart.
 */
test('the MCP schema and the CLI document the same wait parameter', () => {
  const root = path.resolve(__dirname, '../../../..');
  const mcp = readFileSync(path.join(root, 'src/runner-go/mcp.go'), 'utf8');
  const cli = readFileSync(path.join(root, 'src/runner-go/session_cli.go'), 'utf8');

  const descriptor = mcp.slice(mcp.indexOf('"name":        "session_merge"'));
  const schema = descriptor.slice(0, descriptor.indexOf('"name":        "session_end"'));
  assert.ok(schema.length > 0, 'the session_merge descriptor has to be findable to be read');
  assert.match(schema, /"waitSeconds":\s+map\[string\]interface\{\}\{"type": "integer"/);
  assert.match(schema, /maxMergeWaitSeconds/);

  const capability = cli.slice(cli.indexOf('{Tool: "session_merge"'));
  assert.match(capability.slice(0, capability.indexOf('\n')), /--wait-seconds <n>/);
  assert.match(cli, /fs\.Int\("wait-seconds"/);
  assert.match(cli, /body\["waitSeconds"\] = \*waitSeconds/);
});
