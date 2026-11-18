import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Client } from 'pg';
import { prismaClientFor } from '../prisma/prisma-client';
import { SessionsService } from './sessions.service';

/**
 * `worktree: false` on POST /sessions (docs/terminal-session-design.md D4): `orbit` typed in a folder opens a
 * session whose edits land in that folder, so the session runs in its workspace's own directory with no branch
 * and no worktree even when the workspace's setting is worktrees. The runner runs a session with no `branch`
 * directly in the workDir (worktree.go setupWorktree), so "no worktree" is, in rows, a session with a null branch.
 * Every caller may send it, and every caller has it checked.
 */
const PG_URL =
  process.env.COORDINATOR_PG_URL ?? process.env.DATABASE_URL ?? process.env.PG_URL ?? '';

const OWNER_ID = '01a0b1c1-0000-7000-8000-00000000f601';
const RUNNER_ID = '01a0b1c1-0000-7000-8000-00000000f602';
const WORKSPACE_ID = '01a0b1c1-0000-7000-8000-00000000f603';

let admin: Client;
let prisma: ReturnType<typeof prismaClientFor>;
let sessions: SessionsService;

function scenario(name: string, body: () => Promise<void>): void {
  test(name, { skip: PG_URL ? false : 'set COORDINATOR_PG_URL to run the no-worktree suite' }, body);
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
     VALUES ($1::uuid, 'no-worktree@example.test', 'no-worktree', 'test')`,
    [OWNER_ID],
  );
  await admin.query(
    `INSERT INTO "runner"(id, name, owner_id, token_hash, status, last_heartbeat_at)
     VALUES ($1::uuid, 'no-worktree', $2::uuid, 'test', 'ONLINE', clock_timestamp())`,
    [RUNNER_ID, OWNER_ID],
  );
  // The workspace's own setting is worktrees: the override has something to override.
  await admin.query(
    `INSERT INTO "workspace"(id, name, owner_id, runner_id, work_dir, enable_worktree)
     VALUES ($1::uuid, 'no-worktree', $2::uuid, $3::uuid, '/home/dev/shop-api', true)`,
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
  await admin.query(`DELETE FROM "workspace" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "runner" WHERE owner_id = $1::uuid`, [OWNER_ID]);
  await admin.query(`DELETE FROM "user" WHERE id = $1::uuid`, [OWNER_ID]);
}

async function row(sessionId: string) {
  const { rows } = await admin.query<{ branch: string | null; workspace_id: string; assigned_runner_id: string }>(
    `SELECT branch, workspace_id, assigned_runner_id FROM "session" WHERE id = $1::uuid`,
    [sessionId],
  );
  return rows[0];
}

async function sessionCount(): Promise<number> {
  const { rows } = await admin.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM "session" WHERE owner_id = $1::uuid`,
    [OWNER_ID],
  );
  return rows[0].n;
}

scenario('worktree: false runs the session in the workspace directory, no branch, though the workspace says worktrees', async () => {
  const session = await sessions.create(OWNER_ID, {
    prompt: 'add rate limiting to the /login route',
    workspaceId: WORKSPACE_ID,
    effort: '',
    worktree: false,
  });

  assert.deepEqual(await row(session.id), {
    branch: null,
    workspace_id: WORKSPACE_ID,
    assigned_runner_id: RUNNER_ID,
  });
  const { rows } = await admin.query<{ enable_worktree: boolean }>(
    `SELECT enable_worktree FROM "workspace" WHERE id = $1::uuid`,
    [WORKSPACE_ID],
  );
  assert.equal(rows[0].enable_worktree, true, "the workspace's own setting is left as it was");
});

scenario('worktree: false with the runner named alongside the workspace (the terminal sends both) still has no branch', async () => {
  const session = await sessions.create(OWNER_ID, {
    prompt: 'also add a test',
    workspaceId: WORKSPACE_ID,
    assignedRunnerId: RUNNER_ID,
    effort: '',
    worktree: false,
  });
  assert.equal((await row(session.id)).branch, null);
});

scenario('omitted or true follows the workspace: a worktree session with a branch of its own', async () => {
  for (const worktree of [undefined, true]) {
    const session = await sessions.create(OWNER_ID, {
      prompt: `follow the workspace (${String(worktree)})`,
      workspaceId: WORKSPACE_ID,
      effort: '',
      ...(worktree === undefined ? {} : { worktree }),
    });
    const branch = (await row(session.id)).branch;
    assert.ok(branch && branch.startsWith('orbit/'), `worktree ${String(worktree)} → branch ${branch}`);
  }
});

scenario('anything but a boolean is a 400 and nothing is created', async () => {
  const before = await sessionCount();
  for (const worktree of ['false', 0, {}]) {
    await assert.rejects(
      () =>
        sessions.create(OWNER_ID, {
          prompt: 'x',
          workspaceId: WORKSPACE_ID,
          effort: '',
          worktree: worktree as unknown as boolean,
        }),
      (err: unknown) => {
        const e = err as { getStatus?: () => number; message?: string };
        assert.equal(e.getStatus?.(), 400, JSON.stringify(worktree));
        assert.match(String(e.message), /worktree must be a boolean/);
        return true;
      },
    );
  }
  assert.equal(await sessionCount(), before, 'no session was created by a refusal');
});
