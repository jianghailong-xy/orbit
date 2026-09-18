import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import { AutoRetryService } from './auto-retry.service';
import { SessionsService } from './sessions.service';

/**
 * The door the transcript's Retry button asks: what would a manual retry re-send?
 *
 * It used to ask nobody. Both clients paint a session from a 200-event TAIL window and worked the
 * answer out themselves, by looking for a user message inside it. That is right for a conversation
 * and wrong for a run: a task session is one message followed by thousands of tool events — the
 * one this was reported on held 1,740 events with its only user event at seq 1 — so the message
 * sat far outside the window, the clients concluded there was nothing to re-send, and the button
 * was not rendered at all. On exactly the sessions a provider outage kills.
 *
 * So each case below is written so that ANSWERING FROM A TAIL WINDOW is what turns it red: the
 * message to find is older than any window a client paints, and the session's own opening prompt
 * is different text, so a fallback cannot stand in for having found it.
 */
const PG_URL =
  process.env.COORDINATOR_PG_URL ?? process.env.DATABASE_URL ?? process.env.PG_URL ?? '';

const OWNER_ID = '01a0b1c1-0000-7000-8000-00000000e001';
const STRANGER_ID = '01a0b1c1-0000-7000-8000-00000000e002';
const RUNNER_ID = '01a0b1c1-0000-7000-8000-00000000e003';
const WORKSPACE_ID = '01a0b1c1-0000-7000-8000-00000000e004';
const BURIED_SESSION = '01a0b1c1-0000-7000-8000-00000000e005';
const WORDLESS_SESSION = '01a0b1c1-0000-7000-8000-00000000e006';

/** What the person actually said, at seq 1. Never the session's `prompt`, which is seeded with
 *  different text below so a fallback to it cannot pass for having found this. */
const BURIED_MESSAGE = 'run the integration line end to end';
/** The tail both clients paint (TAIL_PAGE / ConsoleModel.tailPage). The noise below is more than
 *  this, so the message is outside every window a client holds. */
const CLIENT_TAIL = 200;
const NOISE_EVENTS = 2_500;

let admin: Client;
let prisma: ReturnType<typeof prismaClientFor>;
let autoRetry: AutoRetryService;

/** Every case needs the database; without it each one reports SKIP, which run-pg-spec.sh calls RED. */
function scenario(name: string, body: () => Promise<void>): void {
  test(name, { skip: PG_URL ? false : 'set COORDINATOR_PG_URL to run the retry-message suite' }, body);
}

before(async () => {
  if (!PG_URL) return;
  admin = new Client({ connectionString: PG_URL });
  await admin.connect();
  prisma = prismaClientFor(PG_URL);
  await prisma.$connect();
  await cleanUp();
  for (const [id, email] of [
    [OWNER_ID, 'retry-message-owner@example.test'],
    [STRANGER_ID, 'retry-message-stranger@example.test'],
  ]) {
    await admin.query(
      `INSERT INTO "user"(id, email, name, password_hash)
       VALUES ($1::uuid, $2, 'retry-message', 'test')`,
      [id, email],
    );
  }
  await admin.query(
    `INSERT INTO "runner"(id, name, owner_id, token_hash, status, last_heartbeat_at)
     VALUES ($1::uuid, 'retry-message', $2::uuid, 'test', 'ONLINE', clock_timestamp())`,
    [RUNNER_ID, OWNER_ID],
  );
  await admin.query(
    `INSERT INTO "workspace"(id, name, owner_id, runner_id)
     VALUES ($1::uuid, 'retry-message', $2::uuid, $3::uuid)`,
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
    if (admin) await cleanUp();
  } finally {
    await prisma?.$disconnect();
    await admin?.end();
  }
});

async function cleanUp(): Promise<void> {
  await admin.query(`DELETE FROM "session" WHERE owner_id = ANY($1::uuid[])`, [[OWNER_ID, STRANGER_ID]]);
  await admin.query(`DELETE FROM "workspace" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "runner" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "user" WHERE id = ANY($1::uuid[])`, [[OWNER_ID, STRANGER_ID]]);
}

/**
 * A session parked the way a self-healing failure leaves one, owned by `ownerId`.
 *
 * `num_turns` is 1, never 0: at zero the chooser is allowed to fall back to the opening prompt,
 * and a case that let it would pass without the buried message ever being found.
 */
async function seedSession(sessionId: string, ownerId: string): Promise<void> {
  await admin.query(
    `INSERT INTO "session"("id","owner_id","creator_id","workspace_id","assigned_runner_id",
                           "title","prompt","provider","status","num_turns","started_at",
                           "runtime_session_id","retry_attempts","updated_at")
     VALUES ($1::uuid,$2::uuid,$2::uuid,$3::uuid,$4::uuid,'parked','an opening prompt nobody asked to re-send',
             'claude','FAILED'::"run_status",1,clock_timestamp(),gen_random_uuid(),0,clock_timestamp())`,
    [sessionId, ownerId, WORKSPACE_ID, RUNNER_ID],
  );
}

/** One user message at seq 1, then a run's worth of tool traffic on top of it. */
async function buryTheMessage(sessionId: string): Promise<void> {
  await admin.query(
    `INSERT INTO "run_event"("id","session_id","seq","type","payload")
     VALUES (gen_random_uuid(),$1::uuid,1,'user',jsonb_build_object('text',$2::text))`,
    [sessionId, BURIED_MESSAGE],
  );
  await admin.query(
    `INSERT INTO "run_event"("id","session_id","seq","type","payload")
     SELECT gen_random_uuid(), $1::uuid, s, 'tool_use', '{"name":"Bash"}'::jsonb
     FROM generate_series(2, $2::int + 1) AS s`,
    [sessionId, NOISE_EVENTS],
  );
}

scenario('the words are found when a run has buried them thousands of events deep', async () => {
  await seedSession(BURIED_SESSION, OWNER_ID);
  await buryTheMessage(BURIED_SESSION);

  // The premise, asserted rather than assumed: nothing a client holds could have answered this.
  const { rows } = await admin.query<{ n: string }>(
    `SELECT count(*) AS n FROM (
       SELECT type FROM "run_event" WHERE session_id = $1::uuid ORDER BY seq DESC LIMIT $2::int
     ) tail WHERE type = 'user'`,
    [BURIED_SESSION, CLIENT_TAIL],
  );
  assert.equal(rows[0].n, '0', 'the tail a client paints must not contain the message');

  const answer = await autoRetry.retryMessage(OWNER_ID, BURIED_SESSION);
  assert.equal(answer.text, BURIED_MESSAGE);
});

scenario('a session with nothing to re-send says so, so no dead button is offered', async () => {
  await seedSession(WORDLESS_SESSION, OWNER_ID);

  const answer = await autoRetry.retryMessage(OWNER_ID, WORDLESS_SESSION);
  assert.equal(answer.text, '', 'the same conclusion that disarms a sweep: nothing to re-send');
});

scenario("someone else's session is not a session this door knows", async () => {
  await assert.rejects(
    () => autoRetry.retryMessage(STRANGER_ID, BURIED_SESSION),
    /session not found/,
    'the message a retry would re-send is the owner\'s to read',
  );
});
