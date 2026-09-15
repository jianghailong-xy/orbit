import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { SessionsService } from './sessions.service';

/**
 * `SessionsService.importSession` — the control-plane half of `orbit session import`.
 *
 * The row it writes is PENDING with `runtimeSessionId` = the Claude session id and a non-null
 * `importSourceCwd`; the runner then copies the transcript into the session's
 * `~/.claude/projects/<slug>/` directory, replays it as run events and clears the marker. This
 * spec pins the CREATE and the four refusals that must answer at create time, before a runner
 * is ever involved — the transcript's cwd must belong to the workspace it will run in, and the
 * same Claude transcript can only be imported once. The "transcript does not exist / holds no
 * real conversation" refusal is the runner's, from its own disk, and lives in its test suite.
 */

const OWNER = '00000000-0000-7000-8000-000000000001';
const WORKSPACE_A = '00000000-0000-7000-8000-0000000000d1';
const WORKSPACE_B = '00000000-0000-7000-8000-0000000000d2';
const CLAUDE_ID = '4e453ab7-f37c-494d-8017-bb4e9beffeef';

function makeService(opts: { claimed?: { id: string; title: string } } = {}) {
  const creates: Array<Record<string, unknown>> = [];
  const workspaces = [
    {
      id: WORKSPACE_A,
      name: 'outer',
      workDir: '/srv/work',
      runnerId: 'runner-1',
      enableWorktree: false,
      enabled: true,
    },
    {
      id: WORKSPACE_B,
      name: 'nested',
      workDir: '/srv/work/project',
      runnerId: 'runner-1',
      enableWorktree: false,
      enabled: true,
    },
  ];
  const tx = {
    // The import-claim serializer's advisory lock — a template tag on the real client.
    $executeRaw: async () => undefined,
    session: {
      findFirst: async () => opts.claimed ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return {
          id: 'session-1',
          ...data,
          endReason: null,
          completedAt: null,
          archivedAt: null,
          deletedAt: null,
        };
      },
    },
  };
  const prisma = {
    $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
    workspace: {
      // Two different reads land here: the import's own (runner/workDir/enabled) and
      // `resolveDefaultEffort`'s. Answered from the same row, distinguished by the select.
      findFirst: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        if (select?.effort) return { effort: null };
        const ws = workspaces.find((w) => w.id === where.id);
        return ws ?? null;
      },
      findMany: async () => workspaces,
    },
    user: { findUnique: async () => ({ preferences: {} }) },
  };
  const queue = { notifySessionQueued: () => undefined } as never;
  const realtime = {
    publishSessionCreated: () => undefined,
  } as never;
  const service = new SessionsService(prisma as never, queue, realtime);
  return { service, creates, tx };
}

test('an id that is not a Claude session UUID is refused before anything else runs', async () => {
  const { service, creates } = makeService();
  await assert.rejects(
    service.importSession(OWNER, { claudeSessionId: 'not-a-uuid', workspaceId: WORKSPACE_A }),
    (err: unknown) =>
      err instanceof BadRequestException && /must be a UUID/.test(String((err as Error).message)),
  );
  assert.deepEqual(creates, [], 'no session row is written for a refused import');
});

test('a transcript recorded outside the workspace is refused with both paths named', async () => {
  const { service, creates } = makeService();
  await assert.rejects(
    service.importSession(OWNER, {
      claudeSessionId: CLAUDE_ID,
      workspaceId: WORKSPACE_A,
      sourceCwd: '/elsewhere/project',
    }),
    (err: unknown) => {
      if (!(err instanceof BadRequestException)) return false;
      const msg = String(err.message);
      return msg.includes('/elsewhere/project') && msg.includes('/srv/work') && msg.includes('outer');
    },
  );
  assert.deepEqual(creates, [], 'the refusal happens at create, not on the runner');
});

test('a cwd equal to the workspace root is inside it', async () => {
  const { service, creates } = makeService();
  await service.importSession(OWNER, {
    claudeSessionId: CLAUDE_ID,
    workspaceId: WORKSPACE_A,
    sourceCwd: '/srv/work',
  });
  assert.equal(creates.length, 1);
});

test('a Claude transcript already imported is refused naming the existing session', async () => {
  const claimed = { id: 'session-9', title: 'the first import' };
  const { service, creates } = makeService({ claimed });
  await assert.rejects(
    service.importSession(OWNER, { claudeSessionId: CLAUDE_ID, workspaceId: WORKSPACE_A }),
    (err: unknown) =>
      err instanceof ConflictException &&
      String(err.message).includes('session-9') &&
      String(err.message).includes('the first import'),
  );
  assert.deepEqual(creates, [], 'a claimed id never yields a second (half-created) session');
});

test('no workspaceId: the transcript cwd picks its workspace, tightest prefix wins', async () => {
  const { service, creates } = makeService();
  await service.importSession(OWNER, {
    claudeSessionId: CLAUDE_ID,
    sourceCwd: '/srv/work/project/src',
  });
  assert.equal(creates.length, 1);
  assert.equal(creates[0].workspaceId, WORKSPACE_B, '/srv/work/project beats /srv/work');
  assert.equal(creates[0].importSourceCwd, '/srv/work/project/src');
});

test('no workspaceId and no cwd match: refused saying how to pick one', async () => {
  const { service, creates } = makeService();
  await assert.rejects(
    service.importSession(OWNER, { claudeSessionId: CLAUDE_ID, sourceCwd: '/nowhere' }),
    (err: unknown) =>
      err instanceof BadRequestException && /pass --workspace/.test(String((err as Error).message)),
  );
  assert.deepEqual(creates, []);
});

test('no workspaceId and no cwd at all: refused', async () => {
  const { service, creates } = makeService();
  await assert.rejects(
    service.importSession(OWNER, { claudeSessionId: CLAUDE_ID }),
    (err: unknown) => err instanceof BadRequestException,
  );
  assert.deepEqual(creates, []);
});

test('a disabled workspace refuses the import', async () => {
  const { service } = makeService();
  const prisma = (service as unknown as { prisma: { workspace: { findFirst: unknown } } }).prisma;
  const realFindFirst = prisma.workspace.findFirst as (args: {
    where: { id: string };
    select?: Record<string, boolean>;
  }) => Promise<Record<string, unknown> | null>;
  prisma.workspace.findFirst = async (args: {
    where: { id: string };
    select?: Record<string, boolean>;
  }) => {
    const ws = await realFindFirst(args);
    if (ws && !args.select?.effort) return { ...ws, enabled: false };
    return ws;
  };
  await assert.rejects(
    service.importSession(OWNER, { claudeSessionId: CLAUDE_ID, workspaceId: WORKSPACE_A }),
    (err: unknown) =>
      err instanceof ForbiddenException && /disabled/.test(String((err as Error).message)),
  );
});

test('the created row is PENDING, resume-shaped, and marked for import', async () => {
  const { service, creates } = makeService();
  await service.importSession(OWNER, {
    claudeSessionId: CLAUDE_ID,
    workspaceId: WORKSPACE_A,
    sourceCwd: '/srv/work',
    title: 'Imported design session',
  });
  const row = creates[0];
  assert.equal(row.runtimeSessionId, CLAUDE_ID, 'the Claude id is what the runner resumes');
  assert.equal(row.importSourceCwd, '/srv/work');
  assert.equal(row.prompt, '');
  assert.equal(row.status, 'PENDING');
  assert.equal(row.provider, 'claude');
  assert.equal(row.providerBuiltin, true);
  // Resume = numTurns > 0 in the claim payload; the seed turn is skipped for import sessions,
  // so this 1 is what makes the first spawn a --resume.
  assert.equal(row.numTurns, 1);
  assert.equal(row.title, 'Imported design session');
  assert.equal(row.assignedRunnerId, 'runner-1');
  assert.equal(row.ownerId, OWNER);
});

test('without a caller title the row carries a placeholder naming the Claude id', async () => {
  const { service, creates } = makeService();
  await service.importSession(OWNER, { claudeSessionId: CLAUDE_ID, workspaceId: WORKSPACE_A });
  assert.equal(creates[0].title, `Imported session ${CLAUDE_ID.slice(0, 8)}`);
});

test('the web path (no cwd known) records the workspace workDir as the import marker', async () => {
  // The web caller cannot read the caller's disk; the runner locates the transcript from the
  // workspace workDir and reports the recorded cwd back with the title.
  const { service, creates } = makeService();
  await service.importSession(OWNER, { claudeSessionId: CLAUDE_ID, workspaceId: WORKSPACE_A });
  assert.equal(creates[0].importSourceCwd, '/srv/work');
});

test('a workspace bound to no runner is refused at create', async () => {
  const { service } = makeService();
  const prisma = (service as unknown as { prisma: { workspace: { findFirst: unknown } } }).prisma;
  const realFindFirst = prisma.workspace.findFirst as (args: {
    where: { id: string };
    select?: Record<string, boolean>;
  }) => Promise<Record<string, unknown> | null>;
  prisma.workspace.findFirst = async (args: {
    where: { id: string };
    select?: Record<string, boolean>;
  }) => {
    const ws = await realFindFirst(args);
    if (ws && !args.select?.effort) return { ...ws, runnerId: null };
    return ws;
  };
  await assert.rejects(
    service.importSession(OWNER, { claudeSessionId: CLAUDE_ID, workspaceId: WORKSPACE_A }),
    (err: unknown) =>
      err instanceof BadRequestException && /runner/.test(String((err as Error).message)),
  );
});
