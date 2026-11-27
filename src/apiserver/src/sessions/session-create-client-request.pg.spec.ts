import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import { SessionsService } from './sessions.service';

/**
 * `clientRequestId` on POST /sessions (migration 1730): the web composer's first message in a new session waits as a
 * "Sending…" bubble and offers Retry when no answer came (docs/mocks/composer-sending-bubble). A request whose answer
 * was lost may still have made its session, so a repeat with the same key answers with that session and opens no
 * second one, even when the two race. The key is per owner, and nothing about it reaches the answer.
 */
const PG_URL =
  process.env.COORDINATOR_PG_URL ?? process.env.DATABASE_URL ?? process.env.PG_URL ?? '';

const OWNER_ID = '01a0b1c1-0000-7000-8000-00000000f701';
const RUNNER_ID = '01a0b1c1-0000-7000-8000-00000000f702';
const WORKSPACE_ID = '01a0b1c1-0000-7000-8000-00000000f703';
const OTHER_OWNER_ID = '01a0b1c1-0000-7000-8000-00000000f704';
const OTHER_RUNNER_ID = '01a0b1c1-0000-7000-8000-00000000f705';
const OTHER_WORKSPACE_ID = '01a0b1c1-0000-7000-8000-00000000f706';

let admin: Client;
let prisma: ReturnType<typeof prismaClientFor>;
let sessions: SessionsService;

function scenario(name: string, body: () => Promise<void>): void {
  test(name, { skip: PG_URL ? false : 'set COORDINATOR_PG_URL to run the client-request suite' }, body);
}

before(async () => {
  if (!PG_URL) return;
  admin = new Client({ connectionString: PG_URL });
  await admin.connect();
  prisma = prismaClientFor(PG_URL);
  await prisma.$connect();
  await cleanUp();
  for (const [owner, runner, workspace, n] of [
    [OWNER_ID, RUNNER_ID, WORKSPACE_ID, 1],
    [OTHER_OWNER_ID, OTHER_RUNNER_ID, OTHER_WORKSPACE_ID, 2],
  ] as const) {
    await admin.query(
      `INSERT INTO "user"(id, email, name, password_hash) VALUES ($1::uuid, $2, 'client-request', 'test')`,
      [owner, `client-request-${n}@example.test`],
    );
    await admin.query(
      `INSERT INTO "runner"(id, name, owner_id, token_hash, status, last_heartbeat_at)
       VALUES ($1::uuid, 'client-request', $2::uuid, 'test', 'ONLINE', clock_timestamp())`,
      [runner, owner],
    );
    await admin.query(
      `INSERT INTO "workspace"(id, name, owner_id, runner_id, work_dir, enable_worktree)
       VALUES ($1::uuid, 'client-request', $2::uuid, $3::uuid, '/home/dev/shop-api', false)`,
      [workspace, owner, runner],
    );
  }
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
  for (const owner of [OWNER_ID, OTHER_OWNER_ID]) {
    await admin.query(`DELETE FROM "session" WHERE owner_id = $1::uuid`, [owner]);
    await admin.query(`DELETE FROM "workspace" WHERE owner_id = $1::uuid`, [owner]);
    await admin.query(`DELETE FROM "runner" WHERE owner_id = $1::uuid`, [owner]);
    await admin.query(`DELETE FROM "user" WHERE id = $1::uuid`, [owner]);
  }
}

async function sessionCount(): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "session" WHERE owner_id = $1::uuid`,
    [OWNER_ID],
  );
  return rows[0].n;
}

async function sessionsWithKey(owner: string, key: string): Promise<string[]> {
  const { rows } = await admin.query<{ id: string }>(
    `SELECT id FROM "session" WHERE owner_id = $1::uuid AND client_request_id = $2`,
    [owner, key],
  );
  return rows.map((r) => r.id);
}

const open = (owner: string, workspace: string, key?: string, prompt = 'check the cluster load every half hour') =>
  sessions.create(owner, { prompt, workspaceId: workspace, effort: '', ...(key === undefined ? {} : { clientRequestId: key }) });

scenario('a repeat with the same key answers with the session the first one made, and opens no second', async () => {
  const key = '6f1c2a9e-1b7d-4c55-9a51-3e0d8f7c2b10';
  const first = await open(OWNER_ID, WORKSPACE_ID, key);
  const again = await open(OWNER_ID, WORKSPACE_ID, key);
  assert.equal(again.id, first.id);
  assert.deepEqual(await sessionsWithKey(OWNER_ID, key), [first.id]);
  assert.equal('clientRequestId' in first, false, 'the key is not part of the answer');
  assert.equal('clientRequestId' in again, false, 'nor of the repeated answer');
  assert.equal(again.title, first.title);
});

scenario('two requests with the same key at once still make one session, and both answer with it', async () => {
  const key = 'b2e4d0c8-7a91-4f3e-8d22-5c6b1a0f9e33';
  const [a, b] = await Promise.all([open(OWNER_ID, WORKSPACE_ID, key), open(OWNER_ID, WORKSPACE_ID, key)]);
  assert.equal(a.id, b.id);
  assert.deepEqual(await sessionsWithKey(OWNER_ID, key), [a.id]);
});

scenario("a key is the owner's own: another account's same key opens its own session", async () => {
  const key = 'c3a5e1d9-8b02-4a4f-9e33-6d7c2b1a0f44';
  const mine = await open(OWNER_ID, WORKSPACE_ID, key);
  const theirs = await open(OTHER_OWNER_ID, OTHER_WORKSPACE_ID, key);
  assert.notEqual(theirs.id, mine.id);
  assert.deepEqual(await sessionsWithKey(OTHER_OWNER_ID, key), [theirs.id]);
});

scenario('no key, or another key, is a new session each time, as before', async () => {
  const a = await open(OWNER_ID, WORKSPACE_ID);
  const b = await open(OWNER_ID, WORKSPACE_ID);
  const c = await open(OWNER_ID, WORKSPACE_ID, 'd4b6f2e0-9c13-4b50-8f44-7e8d3c2b1a55');
  assert.equal(new Set([a.id, b.id, c.id]).size, 3);
});

scenario('a malformed key is a 400 and nothing is created', async () => {
  const before = await sessionCount();
  for (const key of ['short', 'has spaces in it', 'x'.repeat(101), 42]) {
    await assert.rejects(
      () => open(OWNER_ID, WORKSPACE_ID, key as unknown as string),
      (err: unknown) => {
        const e = err as { getStatus?: () => number; message?: string };
        assert.equal(e.getStatus?.(), 400, JSON.stringify(key));
        assert.match(String(e.message), /clientRequestId must be/);
        return true;
      },
    );
  }
  assert.equal(await sessionCount(), before, 'no session was created by a refusal');
});
