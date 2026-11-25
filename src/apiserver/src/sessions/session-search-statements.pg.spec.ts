import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaClient, RunnerStatus, RunStatus, SessionDispatchOrigin } from '@prisma/client';

import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { pgAdapterFor } from '../prisma/prisma-client';
import { countLiveApprovals, countLiveApprovalsBySession } from './abandoned-approvals';
import type { PrismaService } from '../prisma/prisma.service';
import type { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from './sessions.service';

/**
 * A search hit carries the six session facts and the Background mark's inputs (task 353YrK2AEGTm6mfl8GrW9), read for
 * the whole page at once: the approval count behind `waitingOn` (countLiveApprovalsBySession), the owner decisions and
 * the background inputs are each one read of all the hits, so a page of 50 costs the statements a page of 5 does.
 * Against a real PostgreSQL:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-search-statements.pg.spec.ts
 *
 * Each owner's sessions come in four shapes that each give the count a different reader: a turn holding a card, a
 * parked conversation whose runner-hosted job holds one, a task run's turn holding a question, and one holding nothing.
 * Every hit's facts must equal its list row's, whose approvals the list counts its own way (listOverlay).
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const FACTS = ['phase', 'released', 'lastTurnOutcome', 'waitingOn', 'endReason', 'workFinished', 'activity', 'runningBgCount'];

async function owner(db: PrismaClient, run: string, n: number): Promise<{ ownerId: string; ids: string[] }> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `search-${run}-${n}-${ownerId}@statements.invalid`, name: 'search', passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `search-runner-${run}-${n}`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), maxConcurrent: 64, lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'search-agent', enabled: true } });
  const ids: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = randomUUID();
    const shape = i % 4;
    const job = `bgj_${i}`;
    const taskId = shape === 2 ? randomUUID() : null;
    if (taskId) {
      await db.task.create({ data: { id: taskId, ownerId, creatorId: ownerId, creatorType: 'USER', completionCriterion: 'EVIDENCE_JUDGMENT', title: `search task ${i}`, autoRunWhenReady: false } });
    }
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: `search ${run} ${i}`, prompt: 'hello',
        provider: 'claude', dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(), numTurns: 1, taskId,
        status: shape === 1 || shape === 3 ? RunStatus.AWAITING_INPUT : RunStatus.RUNNING,
        lastTurnOutcome: shape === 1 || shape === 3 ? 'ANSWERED' : null,
        createdAt: new Date(Date.now() - i * 1000),
        ...(shape === 1 ? { runningBgShells: [job], runningBgJobs: [job], runningBgJobActivity: { [job]: Date.now() } } : {}),
      },
    });
    if (shape !== 3) {
      await db.approval.create({
        data: {
          sessionId: id, toolName: shape === 2 ? 'AskUserQuestion' : 'Bash', toolUseId: `toolu_${id}`,
          input: shape === 2 ? { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] } : { command: 'make' },
          ...(shape === 1 ? { backgroundJobId: job } : {}),
        },
      });
    }
    ids.push(id);
  }
  return { ownerId, ids };
}

test('a search page costs the same statements for 50 hits as for 5, and each hit says what its list row says', { skip }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  let statements = 0;
  const db = new PrismaClient({ adapter: pgAdapterFor(URL!), log: [{ emit: 'event', level: 'query' }] });
  db.$on('query', () => { statements += 1; });
  const publishes = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const sessions = new SessionsService(
    db as unknown as PrismaService, { notifySessionQueued: () => undefined } as unknown as QueueService, publishes,
  );
  try {
    const run = randomUUID().slice(0, 8);
    const small = await owner(db, run, 5);
    const large = await owner(db, run, 50);
    const searched = async (ownerId: string) => {
      statements = 0;
      const answer = await sessions.search(ownerId, undefined, 50);
      return { answer, statements };
    };
    const five = await searched(small.ownerId);
    const fifty = await searched(large.ownerId);
    assert.equal(five.answer.hits.length, 5);
    assert.equal(fifty.answer.hits.length, 50);
    t.diagnostic(`statements: 5 hits ${five.statements}, 50 hits ${fifty.statements}`);
    assert.ok(fifty.statements > 1, 'statements were counted');
    assert.equal(fifty.statements, five.statements, `50 hits cost ${fifty.statements} statements, 5 hits ${five.statements}`);

    const rows = new Map((await sessions.listRowsByIds(large.ownerId, large.ids)).map((row) => [row.id, row as Record<string, unknown>]));
    const differences: string[] = [];
    for (const hit of fifty.answer.hits as unknown as Array<Record<string, unknown>>) {
      const row = rows.get(hit.id as string)!;
      for (const field of FACTS) {
        if (JSON.stringify(hit[field]) !== JSON.stringify(row[field])) {
          differences.push(`${String(hit.title)} / ${field}: hit ${JSON.stringify(hit[field])}, list row ${JSON.stringify(row[field])}`);
        }
      }
    }
    assert.deepEqual(differences, [], `\n${differences.join('\n')}\n`);
    // The batch the page is counted with says, session by session, what the one-session count says.
    const readers = await db.session.findMany({
      where: { id: { in: large.ids } },
      select: { id: true, taskId: true, status: true, engineTurnActive: true, runningBgShells: true, runningSubagents: true },
    });
    const batched = await countLiveApprovalsBySession(db as never, readers);
    for (const reader of readers) {
      assert.equal(batched.get(reader.id), await countLiveApprovals(db as never, reader), `batched count of ${reader.id}`);
    }
    // The shapes holding a card wait on the person; the one holding nothing does not.
    const waiting = (fifty.answer.hits as unknown as Array<{ title: string; waitingOn: string | null }>)
      .map((hit) => [Number(hit.title.split(' ').pop()) % 4, hit.waitingOn] as const);
    for (const [shape, waitingOn] of waiting) assert.equal(waitingOn, shape === 3 ? null : 'PERSON', `shape ${shape}`);
  } finally {
    await db.$disconnect();
  }
});
