import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import { AutoRetryService } from './auto-retry.service';
import { SessionsService } from './sessions.service';

/**
 * The list pause, against a real PostgreSQL.
 *
 * The unit suite proves what predicate this service hands Prisma; it cannot prove what PostgreSQL
 * does with it, and "a veto that cannot be expressed reads as permission" is a lesson about
 * exactly that gap — the veto it is written about (`NOT EXISTS (... task_list.paused)`) was also a
 * predicate that looked right. So this runs the sweep itself, over two armed sessions that differ
 * in one column, and reads the answer back out of the database.
 *
 * What it pins is the CANDIDATE and CLAIM halves: which of the two rows this sweep takes. Whether
 * the resume that follows a claim then succeeds is the rest of the sweep's business and has its
 * own tests, so the runnable row is asserted on the claim it spent (`retry_attempts = 1`) rather
 * than on the turn it may or may not have written — the held row must show neither.
 */
const PG_URL =
  process.env.COORDINATOR_PG_URL ?? process.env.DATABASE_URL ?? process.env.PG_URL ?? '';

const OWNER_ID = '01a06301-0000-7000-8000-00000000d001';
const RUNNER_ID = '01a06301-0000-7000-8000-00000000d002';
const WORKSPACE_ID = '01a06301-0000-7000-8000-00000000d003';
const HELD_TASK = '01a06301-0000-7000-8000-00000000d004';
const FREE_TASK = '01a06301-0000-7000-8000-00000000d005';
const HELD_SESSION = '01a06301-0000-7000-8000-00000000d006';
const FREE_SESSION = '01a06301-0000-7000-8000-00000000d007';

/** Armed five minutes ago — due, and old enough that ordering by `retry_at` puts the held row
 *  FIRST. That is deliberate: one release per (runner, provider) per sweep, so a veto that only
 *  declined to resume the paused session while still letting it into the page would spend the
 *  sweep's single release on it and starve the runnable one. */
const HELD_ARMED_AT = new Date('2026-09-17T06:00:00.000Z');
const FREE_ARMED_AT = new Date('2026-09-17T06:01:00.000Z');

let admin: Client;
let prisma: ReturnType<typeof prismaClientFor>;
let autoRetry: AutoRetryService;

/** Every case needs the database; without it each one reports SKIP, which run-pg-spec.sh calls RED. */
function scenario(name: string, body: () => Promise<void>): void {
  test(name, { skip: PG_URL ? false : 'set COORDINATOR_PG_URL to run the dispatch-hold suite' }, body);
}

before(async () => {
  if (!PG_URL) return;
  admin = new Client({ connectionString: PG_URL });
  await admin.connect();
  prisma = prismaClientFor(PG_URL);
  await prisma.$connect();
  await admin.query(`DELETE FROM "session" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "task" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "workspace" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "runner" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "user" WHERE id = $1::uuid`, [OWNER_ID]);
  await admin.query(
    `INSERT INTO "user"(id, email, name, password_hash)
     VALUES ($1::uuid, 'auto-retry-hold@example.test', 'hold', 'test')`,
    [OWNER_ID],
  );
  await admin.query(
    `INSERT INTO "runner"(id, name, owner_id, token_hash, status, last_heartbeat_at)
     VALUES ($1::uuid, 'auto-retry-hold', $2::uuid, 'test', 'ONLINE', clock_timestamp())`,
    [RUNNER_ID, OWNER_ID],
  );
  await admin.query(
    `INSERT INTO "workspace"(id, name, owner_id, runner_id)
     VALUES ($1::uuid, 'auto-retry-hold', $2::uuid, $3::uuid)`,
    [WORKSPACE_ID, OWNER_ID, RUNNER_ID],
  );
  const realtime = {
    notifyInbox: () => undefined,
    publish: () => undefined,
    publishSessionUpdated: () => undefined,
    publishQueuedTurnsChanged: () => undefined,
  };
  const queue = { notifySessionQueued: () => undefined };
  const sessions = new SessionsService(prisma as never, queue as never, realtime as never);
  autoRetry = new AutoRetryService(prisma as never, sessions, realtime as never);
});

after(async () => {
  try {
    if (admin) {
      await admin.query(`DELETE FROM "session" WHERE owner_id = $1::uuid`, [OWNER_ID]);
      await admin.query(`DELETE FROM "task" WHERE owner_id = $1::uuid`, [OWNER_ID]);
      await admin.query(`DELETE FROM "workspace" WHERE owner_id = $1::uuid`, [OWNER_ID]);
      await admin.query(`DELETE FROM "runner" WHERE owner_id = $1::uuid`, [OWNER_ID]);
      await admin.query(`DELETE FROM "user" WHERE id = $1::uuid`, [OWNER_ID]);
    }
  } finally {
    await prisma?.$disconnect();
    await admin?.end();
  }
});

/** A task whose list is paused, or not — the one column these two rows differ in. */
async function seedTask(taskId: string, dispatchHold: boolean): Promise<void> {
  await admin.query(
    `INSERT INTO "task"("id","owner_id","assignee_id","title","creator_type","creator_id",
                        "provider","status","updated_at","completion_criterion","dispatch_hold")
     VALUES ($1::uuid,$2::uuid,$3::uuid,'held or not','USER'::"creator_type",$2::uuid,'claude',
             'OPEN'::"task_status",clock_timestamp(),'EVIDENCE_JUDGMENT',$4)`,
    [taskId, OWNER_ID, WORKSPACE_ID, dispatchHold],
  );
}

/**
 * A task's WORK session, parked exactly as a self-healing failure leaves one and armed for a
 * retry: the shape the reaper's offline branch and ingestion's quota branch both produce.
 *
 * The user event is not decoration — without a message to re-send the sweep disarms the row as
 * "nothing to re-send" instead of claiming it, and both halves of this comparison would read the
 * same.
 */
async function seedArmedSession(
  sessionId: string,
  taskId: string,
  armedAt: Date,
): Promise<void> {
  await admin.query(
    `INSERT INTO "session"("id","owner_id","creator_id","task_id","workspace_id",
                           "assigned_runner_id","title","prompt","provider","status",
                           "starts_task_work","num_turns","started_at","runtime_session_id",
                           "retry_at","retry_attempts","updated_at")
     VALUES ($1::uuid,$2::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'armed','opening prompt',
             'claude','AWAITING_INPUT'::"run_status",TRUE,1,clock_timestamp(),gen_random_uuid(),
             $6::timestamptz,0,clock_timestamp())`,
    [sessionId, OWNER_ID, taskId, WORKSPACE_ID, RUNNER_ID, armedAt.toISOString()],
  );
  await admin.query(
    `INSERT INTO "run_event"("id","session_id","seq","type","payload")
     VALUES (gen_random_uuid(),$1::uuid,1,'user','{"text":"the message the failure killed"}'::jsonb)`,
    [sessionId],
  );
}

async function armOf(sessionId: string): Promise<{ retryAt: Date | null; attempts: number }> {
  const { rows } = await admin.query<{ retry_at: Date | null; retry_attempts: number }>(
    `SELECT retry_at, retry_attempts FROM "session" WHERE id = $1::uuid`,
    [sessionId],
  );
  return { retryAt: rows[0].retry_at, attempts: rows[0].retry_attempts };
}

scenario('the sweep takes the runnable session and leaves the paused one armed', async () => {
  await seedTask(HELD_TASK, true);
  await seedTask(FREE_TASK, false);
  await seedArmedSession(HELD_SESSION, HELD_TASK, HELD_ARMED_AT);
  await seedArmedSession(FREE_SESSION, FREE_TASK, FREE_ARMED_AT);
  // What the rows say BEFORE, read back through the same query as after. Compared against itself
  // rather than against the seeded constant, so this is a statement about what the sweep did and
  // not about how two layers spell an instant.
  const armedHeld = await armOf(HELD_SESSION);
  const armedFree = await armOf(FREE_SESSION);

  await autoRetry.sweep(new Date('2026-09-17T06:30:00.000Z'));

  // DEFERRED, and deferral is a thing the row has to SAY: the arm it was found with is still
  // there to the millisecond, and no attempt was spent. That is what makes the retry fire on the
  // first sweep after the pause lifts rather than being abandoned by it.
  const held = await armOf(HELD_SESSION);
  assert.equal(held.retryAt?.getTime(), armedHeld.retryAt?.getTime(),
    'the paused task\'s session keeps the exact arm this sweep found');
  assert.equal(held.attempts, 0, 'and no attempt is spent on a retry that did not happen');

  // ...while the runnable one was claimed, even though the paused row sorted ahead of it and
  // only one release per (runner, provider) exists per sweep.
  const free = await armOf(FREE_SESSION);
  assert.equal(free.attempts, 1, 'the unpaused session is claimed by this same sweep');
  assert.notEqual(free.retryAt?.getTime(), armedFree.retryAt?.getTime(),
    'and its arm is gone: cleared by the claim, or replaced by the backoff behind it');
});

scenario('lifting the pause makes the same session due again, with its budget intact', async () => {
  // The other half of calling it a deferral. Nothing re-arms this row: the arm it kept IS what
  // makes it a candidate the moment `dispatch_hold` goes false, and the attempt it never spent is
  // still there to spend.
  await admin.query(`UPDATE "task" SET dispatch_hold = FALSE WHERE id = $1::uuid`, [HELD_TASK]);
  // The runnable session of the previous case is out of the way, so the one release this sweep has
  // cannot be spent on it.
  await admin.query(`UPDATE "session" SET retry_at = NULL WHERE id = $1::uuid`, [FREE_SESSION]);
  const waiting = await armOf(HELD_SESSION);

  await autoRetry.sweep(new Date('2026-09-17T06:31:00.000Z'));

  const held = await armOf(HELD_SESSION);
  assert.equal(waiting.attempts, 0, 'it comes into this sweep with its budget still whole');
  assert.equal(held.attempts, 1, 'the retry the pause held back is now the one being spent');
  assert.notEqual(held.retryAt?.getTime(), waiting.retryAt?.getTime(), 'the arm it waited on is used');
});
