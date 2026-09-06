/**
 * The compare-and-set that freezes one Session's baseline, under real contention
 * (`docs/project-source-contract.md` SR30, §6.4 rows 7–10, §12.5 S5.01/S5.02/S5.03/S5.06).
 *
 * `source-freeze.pg.spec.ts` shows that two claims arriving one after the other produce one pin.
 * This shows the case that one cannot: two writers that BOTH read `SELECTED` before either of them
 * wrote, which is the only interleaving where "check, then set" can actually go wrong. The fault is
 * injected with a lock — a competing transaction on ANOTHER runner's behalf holds the row while the
 * production call is already inside its UPDATE — so the losing statement really does block, really
 * does re-evaluate its WHERE against a row that changed underneath it, and really does come back
 * having written nothing. That is a concurrent takeover with both halves in flight at once, which
 * is what a lease expiring under a runner that is still resolving actually looks like.
 *
 * Every "nothing moved" assertion here is paired with a case where something does move: the
 * competitor ROLLS BACK in the control and the same blocked call then wins, and every "the frozen
 * snapshot did not follow the configuration" is paired with a session created afterwards that does
 * follow it. A blocked writer that returns 0 rows because it was never let through, and a snapshot
 * that did not change because nothing was changed, are both green against an implementation with no
 * compare-and-set in it at all.
 *
 * Destructive: it truncates. It refuses to run anywhere but the disposable server
 * `coordinator-pg-test-safety` identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import {
  decideSessionSource,
  freezeSessionSourcePin,
  sessionSourceSnapshot,
  SESSION_SOURCE_SELECT,
} from './session-source';

const URL = process.env.COORDINATOR_PG_URL;
const SHA = (c: string) => c.repeat(40);

/** The nine create-frozen columns, which no recovery path may rewrite (§3.2, SR29). */
const SELECTOR_COLUMNS = [
  'sourceKind',
  'sourceCodebaseId',
  'sourceRepoUrl',
  'sourceRootCommitSha',
  'sourceRef',
  'sourceRevisionSha',
  'sourceConfigRevision',
  'sourceRefAuthority',
  'sourceRequiredContains',
] as const;

interface World {
  ownerId: string;
  runnerId: string;
  otherRunnerId: string;
  workspaceId: string;
  projectId: string;
  codebaseId: string;
  taskId: string;
}

async function emptyWorld(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`
    TRUNCATE "run_event", "conversation_turn", "project_codebase", "task", "session",
             "workspace", "runner", "project", "user"
    RESTART IDENTITY CASCADE
  `);
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const otherRunnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@pccs5.invalid`, name: label, passwordHash: 'x' },
  });
  for (const [id, name] of [[runnerId, `${label}-a`], [otherRunnerId, `${label}-b`]] as const) {
    await db.runner.create({
      data: { id, ownerId, name, tokenHash: `x-${id}`, status: RunnerStatus.ONLINE, maxConcurrent: 8 },
    });
  }
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-ws`, enabled: true, workDir: `/tmp/${label}` },
  });
  await db.project.create({ data: { id: projectId, ownerId, title: label } });
  const codebase = await db.projectCodebase.create({
    data: {
      projectId,
      ownerId,
      canonicalRepoUrl: 'https://github.com/acme/widgets',
      upstreamRef: 'refs/heads/main',
      integrationRef: 'refs/heads/main',
      refAuthority: 'REMOTE',
    },
    select: { id: true },
  });
  const task = await db.task.create({
    data: {
      ownerId, projectId, title: `${label} work`, creatorType: 'USER', creatorId: ownerId,
      completionCriterion: 'EVIDENCE_JUDGMENT',
    },
    select: { id: true },
  });
  return { ownerId, runnerId, otherRunnerId, workspaceId, projectId, codebaseId: codebase.id, taskId: task.id };
}

/** A PENDING session created the way `SessionsService.create` creates one: selector in the INSERT. */
async function createSession(db: PrismaClient, w: World): Promise<string> {
  const task = await db.task.findUniqueOrThrow({
    where: { id: w.taskId },
    select: {
      id: true, projectId: true, verifiesTaskId: true, pinnedRevision: true,
      codeless: true, attemptGeneration: true, knownGoodSha: true,
    },
  });
  const decision = await decideSessionSource(db as unknown as PrismaService, task);
  const session = await db.session.create({
    data: {
      title: 'dispatch',
      prompt: 'do the thing',
      status: RunStatus.PENDING,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      taskId: w.taskId,
      provider: 'claude',
      providerBuiltin: true,
      ...decision.columns,
    },
    select: { id: true },
  });
  return session.id;
}

function queueService(db: PrismaClient): QueueService {
  const realtime = {
    publishSessionUpdated: () => {},
    publishSessionCreated: () => {},
    notifyInbox: () => {},
  };
  return new QueueService(db as unknown as PrismaService, realtime as unknown as RealtimeService);
}

/**
 * A second writer, holding the session row inside its own transaction.
 *
 * This is the fault injection, not a second copy of the production statement: what it exists to do
 * is make the production call block mid-UPDATE so that the row it checked and the row it writes are
 * two different versions. `pin` is the competing claim's write and `release` decides whether that
 * competitor is one that COMMITTED or one that went away — the difference the test is about.
 */
class Competitor {
  private constructor(private readonly client: Client, private readonly sessionId: string) {}

  static async holding(url: string, sessionId: string): Promise<Competitor> {
    const client = new Client({ connectionString: url });
    await client.connect();
    await client.query('BEGIN');
    const held = await client.query(
      'SELECT "source_state", "source_base_sha" FROM "session" WHERE "id" = $1 FOR UPDATE',
      [sessionId],
    );
    assert.equal(held.rows[0].source_state, 'SELECTED', 'the competitor did not find an unfrozen session');
    assert.equal(held.rows[0].source_base_sha, null);
    return new Competitor(client, sessionId);
  }

  /** The backend pid, so a caller can watch for somebody else blocking behind it. */
  async pid(): Promise<number> {
    const { rows } = await this.client.query('SELECT pg_backend_pid() AS pid');
    return rows[0].pid;
  }

  async pin(baseSha: string, runnerId: string): Promise<number> {
    const { rowCount } = await this.client.query(
      `UPDATE "session"
          SET "source_state" = 'PINNED', "source_base_sha" = $2,
              "source_resolved_at" = now(), "source_resolved_by_runner_id" = $3
        WHERE "id" = $1 AND "source_state" = 'SELECTED' AND "source_base_sha" IS NULL`,
      [this.sessionId, baseSha, runnerId],
    );
    return rowCount ?? 0;
  }

  async release(how: 'COMMIT' | 'ROLLBACK'): Promise<void> {
    await this.client.query(how);
    await this.client.end();
  }
}

/**
 * Block until somebody other than `exceptPid` is waiting on a lock, so the interleaving under test
 * has actually been reached. Throws rather than returning quietly: a race that never happened would
 * make every assertion after it a statement about a sequence, not a conflict.
 */
async function waitForABlockedWriter(client: Client, exceptPid: number): Promise<void> {
  for (let i = 0; i < 600; i++) {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> $1 AND pid <> pg_backend_pid()
          AND state = 'active' AND wait_event_type = 'Lock'`,
      [exceptPid],
    );
    if (rows[0].n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('no writer ever blocked on the session row; the CAS conflict was never reached');
}

const suite = URL ? test : test.skip;

suite('the SOURCE pin under real contention, on real PostgreSQL', async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  const db = prismaClientFor(URL);
  t.after(async () => {
    await db.$disconnect();
    await client.end();
  });

  // ---------------------------------------------------------------------------------------
  // S5.03 — two writers that both read SELECTED, and the pair of outcomes that tells them apart
  // ---------------------------------------------------------------------------------------

  await t.test('S5.03 a writer blocked by a competitor that COMMITS reads the winner and writes nothing', async () => {
    await emptyWorld(client);
    const w = await world(db, 'cas-commit');
    const sessionId = await createSession(db, w);
    const prisma = db as unknown as PrismaService;

    const competitor = await Competitor.holding(URL!, sessionId);
    const competitorPid = await competitor.pid();

    // The production call is already past its own read of `SELECTED` and inside the UPDATE, where
    // it stops on the competitor's row lock. Nothing about the outcome is decided yet.
    const blocked = freezeSessionSourcePin(
      prisma,
      { sessionId, runnerId: w.runnerId, ownerId: w.ownerId },
      { baseSha: SHA('a') },
    );
    await waitForABlockedWriter(client, competitorPid);

    assert.equal(await competitor.pin(SHA('b'), w.otherRunnerId), 1, 'the competitor did not freeze');
    await competitor.release('COMMIT');

    const loser = await blocked;
    assert.equal(loser.wonRace, false, 'both writers believe they froze the baseline');
    assert.equal(loser.state, 'PINNED');
    assert.equal(loser.baseSha, SHA('b'), 'the loser reported its own answer instead of the committed one');
    assert.equal(loser.resolvedByRunnerId, w.otherRunnerId);

    const row = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: SESSION_SOURCE_SELECT,
    });
    assert.equal(row.sourceBaseSha, SHA('b'), 'the loser overwrote the committed pin');
    assert.equal(row.sourceResolvedByRunnerId, w.otherRunnerId);
  });

  await t.test('S5.03 the same blocked writer WINS when the competitor rolls back', async () => {
    await emptyWorld(client);
    const w = await world(db, 'cas-rollback');
    const sessionId = await createSession(db, w);
    const prisma = db as unknown as PrismaService;

    // Byte for byte the case above, with one difference: the competing transaction goes away
    // instead of committing. Without this control, "the blocked writer wrote nothing" would be
    // equally true of a writer the lock never released, and of an implementation whose UPDATE
    // matches no row for some entirely different reason.
    const competitor = await Competitor.holding(URL!, sessionId);
    const competitorPid = await competitor.pid();
    const blocked = freezeSessionSourcePin(
      prisma,
      { sessionId, runnerId: w.runnerId, ownerId: w.ownerId },
      { baseSha: SHA('a') },
    );
    await waitForABlockedWriter(client, competitorPid);

    assert.equal(await competitor.pin(SHA('b'), w.otherRunnerId), 1);
    await competitor.release('ROLLBACK');

    const winner = await blocked;
    assert.equal(winner.wonRace, true, 'the writer stayed blocked out after the competitor withdrew');
    assert.equal(winner.baseSha, SHA('a'));

    const row = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: SESSION_SOURCE_SELECT,
    });
    assert.equal(row.sourceBaseSha, SHA('a'));
    assert.equal(row.sourceResolvedByRunnerId, w.runnerId);
  });

  // ---------------------------------------------------------------------------------------
  // S5.02 — one baseline per session, whoever asks and however often
  // ---------------------------------------------------------------------------------------

  await t.test('S5.02 eight racers, a takeover and every retry read one and the same baseline', async () => {
    await emptyWorld(client);
    const w = await world(db, 'cas-census');
    const sessionId = await createSession(db, w);
    const prisma = db as unknown as PrismaService;
    const actor = { sessionId, runnerId: w.runnerId, ownerId: w.ownerId };

    // Eight simultaneous answers, each a DIFFERENT commit: repeated dispatch, a retried request
    // whose response was lost, two claims of the same queued session. Whichever wins, seven writers
    // hold a commit that is not the session's baseline and none of them may install it.
    const racers = ['1', '2', '3', '4', '5', '6', '7', '8'];
    const answers = await Promise.all(
      racers.map((c) => freezeSessionSourcePin(prisma, actor, { baseSha: SHA(c) })),
    );
    assert.equal(answers.filter((a) => a.wonRace).length, 1, 'more than one writer froze the baseline');
    const frozen = answers[0].baseSha!;
    assert.ok(racers.map(SHA).includes(frozen), 'the frozen baseline is not one of the offered commits');
    for (const [i, a] of answers.entries()) {
      assert.equal(a.state, 'PINNED', `racer ${i} did not end PINNED`);
      assert.equal(a.baseSha, frozen, `racer ${i} was told a different baseline`);
    }

    // A takeover: the session moves to another machine, which resolves independently and offers a
    // ninth commit. Same answer — the pin belongs to the session, not to whoever is holding it.
    await db.session.update({ where: { id: sessionId }, data: { assignedRunnerId: w.otherRunnerId } });
    const takeover = await freezeSessionSourcePin(
      prisma,
      { sessionId, runnerId: w.otherRunnerId, ownerId: w.ownerId },
      { baseSha: SHA('9') },
    );
    assert.equal(takeover.wonRace, false);
    assert.equal(takeover.baseSha, frozen);

    // And every later read, by any path, is the same value.
    const reclaimed = await queueService(db).claimSessionForRunner({ id: w.otherRunnerId }, 0, false, true);
    assert.equal(reclaimed?.sessionId, sessionId);
    assert.equal(reclaimed?.source?.baseSha, frozen);
    for (let i = 0; i < 8; i++) {
      const again = await freezeSessionSourcePin(
        prisma,
        { sessionId, runnerId: w.otherRunnerId, ownerId: w.ownerId },
        { baseSha: SHA('9') },
      );
      assert.equal(again.baseSha, frozen, `retry ${i} read a different baseline`);
      assert.equal(again.wonRace, false);
    }

    // The census the acceptance asks for, taken from the table rather than from the answers: at
    // most one `source_base_sha` has ever existed for this session.
    const { rows } = await client.query(
      'SELECT DISTINCT "source_base_sha" FROM "session" WHERE "id" = $1',
      [sessionId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source_base_sha, frozen);
  });

  // ---------------------------------------------------------------------------------------
  // §6.4 rows 1 and 4 — a claim that died, and the process that comes back for it
  // ---------------------------------------------------------------------------------------

  await t.test('§6.4 rows 1/4 a claim that died before pinning froze nothing, and the retry decides', async () => {
    await emptyWorld(client);
    const w = await world(db, 'cas-crash');
    const sessionId = await createSession(db, w);
    const prisma = db as unknown as PrismaService;
    const queue = queueService(db);

    // A runner claims the session and dies between step 1 and step 3 — the resolution happened on a
    // machine that is now gone, and the control plane never heard the answer.
    const firstClaim = await queue.claimSessionForRunner({ id: w.runnerId }, 0, false, true);
    assert.equal(firstClaim?.sessionId, sessionId);
    assert.equal(firstClaim?.source?.state, 'SELECTED');
    assert.equal(firstClaim?.source?.baseSha, undefined, 'a session was handed out already pinned');
    const abandoned = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: SESSION_SOURCE_SELECT,
    });
    assert.equal(abandoned.sourceState, 'SELECTED', 'a claim that never answered moved the state machine');
    assert.equal(abandoned.sourceBaseSha, null);
    assert.equal(abandoned.sourceResolvedAt, null);
    assert.equal(abandoned.sourceResolvedByRunnerId, null);

    // What actually recovers it: the lease sweep puts a session whose runner stopped answering back
    // on the queue. The claim path only ever takes PENDING rows, so this is the requeue and not a
    // shortcut around one.
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.PENDING } });

    // The retry is a fresh resolution and is ALLOWED to reach a different commit: nothing was
    // frozen, and a ref that moved between two attempts that both failed to freeze is legal
    // (§6.4, first row). This is the one row where a NEW answer is the correct outcome, and having
    // it here is what stops every other row's "it did not change" from being a property of a
    // fixture in which nothing ever changes.
    const retry = await queue.claimSessionForRunner({ id: w.runnerId }, 0, false, true);
    assert.equal(retry?.sessionId, sessionId);
    assert.equal(retry?.source?.state, 'SELECTED');
    assert.equal(retry?.source?.baseSha, undefined);
    const frozen = await freezeSessionSourcePin(
      prisma, { sessionId, runnerId: w.runnerId, ownerId: w.ownerId }, { baseSha: SHA('7') },
    );
    assert.equal(frozen.wonRace, true, 'a session nobody had pinned refused the first writer to try');
    assert.equal(frozen.baseSha, SHA('7'));

    // Row 4: the runner process restarts and rebuilds its supervisors from the reclaim projection —
    // the same `sessionSourceSnapshot` over the same columns that `GET sessions/reclaim` serves,
    // reached here without a Nest application because what is worth proving is what the ROW says.
    // From here on the answer is fixed; the dead attempt's window closed behind it.
    const row = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: SESSION_SOURCE_SELECT,
    });
    const binding = await db.projectCodebase.findUniqueOrThrow({
      where: { id: w.codebaseId }, select: { remoteName: true, authorityRunnerId: true },
    });
    const afterRestart = sessionSourceSnapshot(row, binding);
    assert.equal(afterRestart?.state, 'PINNED');
    assert.equal(afterRestart?.baseSha, SHA('7'));
    const late = await freezeSessionSourcePin(
      prisma, { sessionId, runnerId: w.runnerId, ownerId: w.ownerId }, { baseSha: SHA('8') },
    );
    assert.equal(late.wonRace, false);
    assert.equal(late.baseSha, SHA('7'), 'the restarted process re-froze the baseline');
  });

  // ---------------------------------------------------------------------------------------
  // §6.4 rows 7–9 — the configuration moves on and the frozen run does not
  // ---------------------------------------------------------------------------------------

  await t.test('§6.4 rows 7–9 a reconfigured binding reaches the next session, never the pinned one', async () => {
    await emptyWorld(client);
    const w = await world(db, 'cas-config');
    const sessionId = await createSession(db, w);
    const prisma = db as unknown as PrismaService;

    const pinned = await freezeSessionSourcePin(
      prisma, { sessionId, runnerId: w.runnerId, ownerId: w.ownerId }, { baseSha: SHA('a') },
    );
    assert.equal(pinned.wonRace, true);
    const before = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: SESSION_SOURCE_SELECT,
    });

    // Row 7: the ref this run was frozen against is repointed. Row 8: the binding is reconfigured
    // and its `configRevision` advances with it (the trigger owns that column). Row 9's shape, as
    // far as this build can express it: a later fact about the task's own code identity — the
    // known-good commit a retry would continue from — appears after the pin.
    await db.projectCodebase.update({
      where: { id: w.codebaseId },
      data: { upstreamRef: 'refs/heads/develop', integrationRef: 'refs/heads/develop' },
    });
    await db.task.update({
      where: { id: w.taskId },
      data: { knownGoodSha: SHA('e'), attemptGeneration: 1n },
    });
    const codebase = await db.projectCodebase.findUniqueOrThrow({
      where: { id: w.codebaseId }, select: { configRevision: true },
    });
    assert.ok(codebase.configRevision > (before.sourceConfigRevision ?? 0n),
      'the fixture did not actually advance the configuration');

    // Every recovery path reads. The claim projection is the one the runner sees; the row is what
    // the record says. Neither moved, in any of the ten columns.
    const reclaimed = await queueService(db).claimSessionForRunner({ id: w.runnerId }, 0, false, true);
    assert.equal(reclaimed?.sessionId, sessionId);
    assert.equal(reclaimed?.source?.baseSha, SHA('a'));
    assert.equal(reclaimed?.source?.ref, 'refs/heads/main');
    assert.equal(reclaimed?.source?.kind, 'PROJECT_UPSTREAM');

    const after = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: SESSION_SOURCE_SELECT,
    });
    assert.equal(after.sourceBaseSha, SHA('a'));
    for (const column of SELECTOR_COLUMNS) {
      assert.deepEqual(after[column], before[column], `${column} followed the configuration`);
    }

    // The paired positive: the same task, dispatched again NOW, resolves against the configuration
    // as it is now. Without this, "the snapshot did not change" would also be green in a world
    // where none of the edits above took effect.
    //
    // The pinned run has to end first — `session_task_execution_claim_idx` allows one live session
    // per task — which is also what a rerun really looks like.
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.SUCCEEDED } });
    const next = await createSession(db, w);
    const fresh = await db.session.findUniqueOrThrow({
      where: { id: next }, select: SESSION_SOURCE_SELECT,
    });
    assert.equal(fresh.sourceState, 'SELECTED');
    assert.equal(fresh.sourceKind, 'TASK_KNOWN_GOOD', 'the later known-good commit did not reach the next run');
    assert.equal(fresh.sourceRevisionSha, SHA('e'));
    assert.equal(fresh.sourceConfigRevision, codebase.configRevision);
    assert.notEqual(fresh.sourceConfigRevision, before.sourceConfigRevision);

    // And the frozen one is still frozen, now that a second session exists to be confused with it.
    const settled = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: SESSION_SOURCE_SELECT,
    });
    assert.deepEqual(settled, after, 'the pinned session changed once a newer one was created');
  });

  // ---------------------------------------------------------------------------------------
  // §6.4 row 10 / S5.06 — REFUSED is terminal, and the way back is a new session
  // ---------------------------------------------------------------------------------------

  await t.test('S5.06 a REFUSED session never resolves again, and the rerun freezes a new selector', async () => {
    await emptyWorld(client);
    const w = await world(db, 'cas-refused');
    const sessionId = await createSession(db, w);
    const prisma = db as unknown as PrismaService;
    const actor = { sessionId, runnerId: w.runnerId, ownerId: w.ownerId };

    const refused = await freezeSessionSourcePin(prisma, actor, {
      refusal: { code: 'BASE_REF_NOT_FOUND', detail: { ref: 'refs/heads/main' } },
    });
    assert.equal(refused.state, 'REFUSED');
    const at = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: SESSION_SOURCE_SELECT,
    });

    // The user fixes the binding — which is the event row 10 is about, and the one that most looks
    // like it should reopen the question.
    await db.projectCodebase.update({
      where: { id: w.codebaseId }, data: { upstreamRef: 'refs/heads/release' },
    });

    // Every later event, including the two a runner can produce, leaves it exactly where it is.
    for (const request of [
      { baseSha: SHA('a') },
      { refusal: { code: 'SOURCE_AUTHORITY_UNREACHABLE' as const, detail: {} } },
    ]) {
      const late = await freezeSessionSourcePin(prisma, actor, request);
      assert.equal(late.wonRace, false);
      assert.equal(late.state, 'REFUSED');
      assert.equal(late.refusalCode, 'BASE_REF_NOT_FOUND', 'a later event rewrote the refusal');
      assert.equal(late.baseSha, undefined);
    }
    const still = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: SESSION_SOURCE_SELECT,
    });
    assert.deepEqual(still, at, 'a terminal session was written to');

    // And the recovery path that DOES exist: a new session, frozen against the configuration as it
    // stands now. A refused run never started, so the runner ends it — and that is what frees the
    // task's one live-session slot for the rerun.
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.FAILED } });
    const rerun = await createSession(db, w);
    assert.notEqual(rerun, sessionId);
    const fresh = await db.session.findUniqueOrThrow({
      where: { id: rerun }, select: SESSION_SOURCE_SELECT,
    });
    assert.equal(fresh.sourceState, 'SELECTED');
    assert.equal(fresh.sourceRef, 'refs/heads/release');
    assert.ok((fresh.sourceConfigRevision ?? 0n) > (at.sourceConfigRevision ?? 0n),
      'the rerun did not freeze a newer configRevision');
    assert.equal(fresh.sourceBaseSha, null, 'the rerun arrived already pinned');
    assert.equal(fresh.sourceRefusalCode, null);

    // The refused session keeps its own account of what went wrong; a rerun is not a retraction.
    const terminal = await db.session.findUniqueOrThrow({
      where: { id: sessionId }, select: SESSION_SOURCE_SELECT,
    });
    assert.deepEqual(terminal, still, 'creating the rerun rewrote the session it replaces');
  });
});
