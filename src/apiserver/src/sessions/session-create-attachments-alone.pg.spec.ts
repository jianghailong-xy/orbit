import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import { SessionsService } from './sessions.service';

/**
 * A new session opened with attachments and no words — a file dropped into the composer and sent.
 *
 * Every later turn could already be that; only the opening one was refused, with a bare
 * "prompt is required". Accepting it is not enough on its own: the claim seeds the opening turn
 * from the prompt and reads an empty one as an imported transcript's, so a session let through
 * with nothing else changed would start with no turn at all and its files would never reach the
 * engine. The inbox hands the runner exactly the attachments linked to the turn it delivers, so
 * "the files arrive" is, in rows, the seeded turn with the upload linked to it.
 */
const PG_URL =
  process.env.COORDINATOR_PG_URL ?? process.env.DATABASE_URL ?? process.env.PG_URL ?? '';

const OWNER_ID = '01a0b1c1-0000-7000-8000-00000000f101';
const RUNNER_ID = '01a0b1c1-0000-7000-8000-00000000f102';
const WORKSPACE_ID = '01a0b1c1-0000-7000-8000-00000000f103';

let admin: Client;
let prisma: ReturnType<typeof prismaClientFor>;
let sessions: SessionsService;

function scenario(name: string, body: () => Promise<void>): void {
  test(name, { skip: PG_URL ? false : 'set COORDINATOR_PG_URL to run the attachments-alone suite' }, body);
}

before(async () => {
  if (!PG_URL) return;
  admin = new Client({ connectionString: PG_URL });
  await admin.connect();
  prisma = prismaClientFor(PG_URL);
  await prisma.$connect();
  await cleanUp();
  await admin.query(
    `INSERT INTO "user"(id, email, name, password_hash)
     VALUES ($1::uuid, 'attachments-alone@example.test', 'attachments-alone', 'test')`,
    [OWNER_ID],
  );
  await admin.query(
    `INSERT INTO "runner"(id, name, owner_id, token_hash, status, last_heartbeat_at)
     VALUES ($1::uuid, 'attachments-alone', $2::uuid, 'test', 'ONLINE', clock_timestamp())`,
    [RUNNER_ID, OWNER_ID],
  );
  await admin.query(
    `INSERT INTO "workspace"(id, name, owner_id, runner_id)
     VALUES ($1::uuid, 'attachments-alone', $2::uuid, $3::uuid)`,
    [WORKSPACE_ID, OWNER_ID, RUNNER_ID],
  );
  sessions = new SessionsService(
    prisma as never,
    { notifySessionQueued: () => undefined } as never,
    {
      publishSessionCreated: () => undefined,
      publishWorkspaceChanged: () => undefined,
    } as never,
  );
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
  await admin.query(`DELETE FROM "session" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "attachment" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "workspace" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "runner" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "user" WHERE id = $1::uuid`, [OWNER_ID]);
}

/** A compose-page upload: the owner's, not yet scoped to any session, turn or task. */
async function upload(fileName: string): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `INSERT INTO "attachment"(id, owner_id, mime_type, size_bytes, file_name, data)
     VALUES (gen_random_uuid(), $1::uuid, 'application/zip', 3, $2, '\\x504b03'::bytea)
     RETURNING id`,
    [OWNER_ID, fileName],
  );
  return rows[0].id;
}

async function turnsOf(sessionId: string) {
  const { rows } = await admin.query<{
    id: string;
    client_turn_id: string;
    kind: string;
    content: string | null;
    status: string;
  }>(
    `SELECT id, client_turn_id, kind, content, status::text AS status
       FROM "conversation_turn" WHERE session_id = $1::uuid ORDER BY seq`,
    [sessionId],
  );
  return rows;
}

async function attachmentRow(id: string) {
  const { rows } = await admin.query<{ session_id: string | null; turn_id: string | null }>(
    `SELECT session_id, turn_id FROM "attachment" WHERE id = $1::uuid`,
    [id],
  );
  return rows[0];
}

scenario('attachments with no words open a session whose first turn carries them', async () => {
  const attachmentId = await upload('testflight_feedback.zip');

  const session = await sessions.create(OWNER_ID, {
    prompt: '',
    workspaceId: WORKSPACE_ID,
    effort: '',
    attachmentIds: [attachmentId],
  });

  assert.equal(session.prompt, '');
  assert.equal(session.title, 'testflight_feedback.zip', 'named for the file it was opened with');
  const turns = await turnsOf(session.id);
  assert.deepEqual(
    turns.map(({ client_turn_id, kind, content, status }) => ({ client_turn_id, kind, content, status })),
    [{ client_turn_id: `initial-${session.id}`, kind: 'message', content: '', status: 'PENDING' }],
    'the opening turn is laid down at create, under the id the claim would have used',
  );
  assert.deepEqual(
    await attachmentRow(attachmentId),
    { session_id: session.id, turn_id: turns[0].id },
    'the upload rides on that turn, which is what the inbox hands the runner',
  );
});

scenario('a session opened with words lays its opening turn down at create, with the upload on it', async () => {
  const attachmentId = await upload('crash.log');

  const session = await sessions.create(OWNER_ID, {
    prompt: 'debug it, pls',
    workspaceId: WORKSPACE_ID,
    effort: '',
    attachmentIds: [attachmentId],
  });

  assert.equal(session.title, 'debug it, pls');
  const turns = await turnsOf(session.id);
  assert.deepEqual(
    turns.map(({ client_turn_id, kind, content, status }) => ({ client_turn_id, kind, content, status })),
    [{ client_turn_id: `initial-${session.id}`, kind: 'message', content: 'debug it, pls', status: 'PENDING' }],
    'the opening is a turn before any runner claims the session',
  );
  assert.deepEqual(await attachmentRow(attachmentId), { session_id: session.id, turn_id: turns[0].id });
});

scenario('a queued session lists its opening as the accepted head until the runner echoes it', async () => {
  const session = await sessions.create(OWNER_ID, {
    prompt: 'Fix: Codex update failed',
    workspaceId: WORKSPACE_ID,
    effort: '',
  });
  const [opening] = await turnsOf(session.id);

  const active = (await sessions.listQueuedTurns(OWNER_ID, session.id, 'active')) as Array<{
    turnId: string; kind: string; placement: string; content: string; opening?: true;
  }>;
  assert.deepEqual(
    active.map(({ turnId, kind, placement, content, opening }) => ({ turnId, kind, placement, content, opening })),
    [{ turnId: opening.id, kind: 'message', placement: 'accepted', content: 'Fix: Codex update failed', opening: true }],
    'unclaimed, the first message is what the session page draws',
  );
  assert.deepEqual(
    await sessions.listQueuedTurns(OWNER_ID, session.id),
    [],
    'the queue itself still leaves the opening out: it is no follow-up to withdraw',
  );

  // The runner claims it and echoes the opening: the transcript draws it from now on, so the
  // active view must stop listing it, or a client would draw it twice.
  await admin.query(
    `UPDATE "conversation_turn" SET status = 'IN_FLIGHT' WHERE id = $1::uuid`,
    [opening.id],
  );
  assert.equal(
    ((await sessions.listQueuedTurns(OWNER_ID, session.id, 'active')) as unknown[]).length,
    1,
    'taken but not yet echoed, it is still the accepted head',
  );
  await admin.query(
    `INSERT INTO "run_event"(session_id, seq, type, payload, turn_id)
     VALUES ($1::uuid, 1, 'user', '{"text":"Fix: Codex update failed"}'::jsonb, $2::uuid)`,
    [session.id, opening.id],
  );
  assert.deepEqual(
    await sessions.listQueuedTurns(OWNER_ID, session.id, 'active'),
    [],
    'echoed, the transcript holds the one copy',
  );
});

scenario('no words and nothing attached, or a shell command without its words, is still refused', async () => {
  const attachmentId = await upload('notes.zip');
  const beforeRows = await admin.query(`SELECT 1 FROM "session" WHERE owner_id = $1::uuid`, [OWNER_ID]);

  for (const dto of [
    { prompt: '' },
    { prompt: '', attachmentIds: [] },
    { prompt: '', shell: true, attachmentIds: [attachmentId] },
    // A missing field is a malformed request, not an empty message: refused, not a TypeError.
    { prompt: undefined as unknown as string, attachmentIds: [attachmentId] },
  ]) {
    await assert.rejects(
      () => sessions.create(OWNER_ID, { ...dto, workspaceId: WORKSPACE_ID, effort: '' }),
      /prompt is required/,
      JSON.stringify(dto),
    );
  }

  const afterRows = await admin.query(`SELECT 1 FROM "session" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  assert.equal(afterRows.rowCount, beforeRows.rowCount, 'no session was created by a refusal');
  assert.deepEqual(await attachmentRow(attachmentId), { session_id: null, turn_id: null });
});
