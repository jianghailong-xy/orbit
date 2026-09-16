import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { SessionsService } from './sessions.service';

/**
 * `SessionsService.importBatch` / `countImported` / `removeImported` — taking over a directory that
 * already has Claude Code conversations in it, and being able to undo that.
 *
 * The batch is a wrapper around `importSession`, so what it owes is not a second import: it is the
 * two decisions a batch has that a single import does not. First, WHICH refusals stop everything —
 * a workspace that is not the caller's is about the request, while "that one conversation was
 * already imported" is about one item and must not cost the other nineteen. Second, that consent
 * given for a directory's history as a whole can be withdrawn the same way, which is what the
 * offer's "they can be removed later" promises out loud.
 */

const OWNER = '00000000-0000-7000-8000-000000000001';
const WORKSPACE = '00000000-0000-7000-8000-0000000000d1';
const OTHER_OWNERS_WORKSPACE = '00000000-0000-7000-8000-0000000000d9';
const ID_A = '4e453ab7-f37c-494d-8017-bb4e9beffeef';
const ID_B = '882f30d6-3862-4339-a1e7-9b799cb18de3';
const ID_C = 'f68bea9b-8d63-4b31-8dcc-ac6d0933efed';

function makeService(opts: { claimed?: Set<string>; imported?: string[] } = {}) {
  const creates: Array<Record<string, unknown>> = [];
  const counts: Array<Record<string, unknown>> = [];
  const findManies: Array<Record<string, unknown>> = [];
  const workspace = {
    id: WORKSPACE,
    name: 'orbit',
    workDir: '/root/orbit',
    runnerId: 'runner-1',
    enableWorktree: false,
    enabled: true,
  };
  const tx = {
    $executeRaw: async () => undefined,
    session: {
      findFirst: async ({ where }: { where: { runtimeSessionId: string } }) =>
        opts.claimed?.has(where.runtimeSessionId)
          ? { id: 'session-already', title: 'imported last week' }
          : null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        creates.push(data);
        return {
          id: `session-${creates.length}`,
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
      findFirst: async ({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) => {
        if (select?.effort) return { effort: null };
        return where.id === WORKSPACE ? workspace : null;
      },
      findMany: async () => [workspace],
    },
    user: { findUnique: async () => ({ preferences: {} }) },
    session: {
      count: async ({ where }: { where: Record<string, unknown> }) => {
        counts.push(where);
        return opts.imported?.length ?? 0;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        findManies.push(where);
        return (opts.imported ?? []).map((id) => ({ id }));
      },
    },
  };
  const queue = { notifySessionQueued: () => undefined } as never;
  const realtime = { publishSessionCreated: () => undefined } as never;
  const service = new SessionsService(prisma as never, queue, realtime);
  return { service, creates, counts, findManies };
}

test("every transcript in the directory's history becomes its own pending import", async () => {
  const { service, creates } = makeService();
  const result = await service.importBatch(OWNER, {
    workspaceId: WORKSPACE,
    transcripts: [
      { claudeSessionId: ID_A, title: 'first principles' },
      { claudeSessionId: ID_B },
      { claudeSessionId: ID_C },
    ],
  });

  assert.equal(result.imported, 3);
  assert.equal(result.sessionIds.length, 3);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(
    creates.map((c) => c.runtimeSessionId),
    [ID_A, ID_B, ID_C],
    'each transcript is imported under its own Claude session id',
  );
  // Pending import: the runner replays the transcript before the engine spawns. Nothing here waits
  // for that, which is what lets the workspace be usable the moment it is created.
  assert.equal(creates[0].importSourceCwd, '/root/orbit');
  assert.equal(creates[0].numTurns, 1, 'resume = numTurns > 0, so the spawn carries the context');
  // Durable provenance, so the removal below has something to select on after the replay lands.
  assert.ok(creates[0].importedAt instanceof Date, 'an imported session is marked as one');
  assert.equal(
    creates[0].title,
    'first principles',
    "the conversation keeps the name it already had, rather than 'Imported session 4e453ab7'",
  );
});

test('a conversation that was already imported is skipped, and the rest of the directory still lands', async () => {
  const { service, creates } = makeService({ claimed: new Set([ID_B]) });
  const result = await service.importBatch(OWNER, {
    workspaceId: WORKSPACE,
    transcripts: [{ claudeSessionId: ID_A }, { claudeSessionId: ID_B }, { claudeSessionId: ID_C }],
  });

  assert.equal(result.imported, 2, 'one refusal must not cost the other conversations');
  assert.deepEqual(
    creates.map((c) => c.runtimeSessionId),
    [ID_A, ID_C],
  );
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].claudeSessionId, ID_B);
  assert.match(
    result.skipped[0].reason,
    /already imported/,
    'the skip says which conversation and why, in the same words a single import would',
  );
});

test("a workspace that is not the caller's stops the batch instead of failing every transcript", async () => {
  const { service, creates } = makeService();
  await assert.rejects(
    service.importBatch(OWNER, {
      workspaceId: OTHER_OWNERS_WORKSPACE,
      transcripts: [{ claudeSessionId: ID_A }, { claudeSessionId: ID_B }],
    }),
    (err: unknown) => err instanceof ForbiddenException,
  );
  assert.deepEqual(creates, [], 'nothing is written, and the refusal is about the request');
});

test('an empty batch is refused rather than reported as a successful import of nothing', async () => {
  const { service } = makeService();
  await assert.rejects(
    service.importBatch(OWNER, { workspaceId: WORKSPACE, transcripts: [] }),
    (err: unknown) => err instanceof BadRequestException,
  );
});

test('a batch larger than one scan can report is refused', async () => {
  const { service, creates } = makeService();
  const tooMany = Array.from({ length: 201 }, (_, i) => ({
    claudeSessionId: `0000000${(i % 10).toString()}-0000-4000-8000-00000000000${(i % 10).toString()}`,
  }));
  await assert.rejects(
    service.importBatch(OWNER, { workspaceId: WORKSPACE, transcripts: tooMany }),
    (err: unknown) => err instanceof BadRequestException,
  );
  assert.deepEqual(creates, []);
});

test('the count the removal offer states is of live imported sessions only', async () => {
  const { service, counts } = makeService({ imported: ['s1', 's2'] });
  const result = await service.countImported(OWNER, WORKSPACE);

  assert.deepEqual(result, { count: 2 });
  assert.deepEqual(counts[0], {
    ownerId: OWNER,
    workspaceId: WORKSPACE,
    importedAt: { not: null },
    deletedAt: null,
  });
});

test("history that came in as a directory goes back out as one, through each session's own door", async () => {
  const { service, findManies } = makeService({ imported: ['s1', 's2', 's3'] });
  const removed: string[] = [];
  service.remove = async (_owner: string, id: string) => {
    removed.push(id);
    return { ok: true };
  };

  const result = await service.removeImported(OWNER, WORKSPACE);

  assert.deepEqual(result, { removed: 3, requested: 3 });
  assert.deepEqual(removed, ['s1', 's2', 's3'], 'each one leaves the way a hand-deleted session does');
  assert.deepEqual(findManies[0], {
    ownerId: OWNER,
    workspaceId: WORKSPACE,
    importedAt: { not: null },
    deletedAt: null,
  });
});

test('a session that disappears underneath the sweep is counted as gone, not as a failure', async () => {
  const { service } = makeService({ imported: ['s1', 's2', 's3'] });
  service.remove = async (_owner: string, id: string) => {
    if (id === 's2') throw new Error('session not found');
    return { ok: true };
  };

  const result = await service.removeImported(OWNER, WORKSPACE);

  assert.deepEqual(result, { removed: 2, requested: 3 }, 'the sweep reports both numbers rather than throwing');
});

test('removing without naming a workspace is refused, so a stray call cannot sweep an account', async () => {
  const { service } = makeService({ imported: ['s1'] });
  await assert.rejects(
    service.removeImported(OWNER, ''),
    (err: unknown) => err instanceof BadRequestException,
  );
});
