import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { LoginEngine, RunnerEngineHealth } from '@orbit/shared';
import type { AuthUser } from '../common/current-user.decorator';
import { CLAUDE_ACCOUNT_REMOVE_V1 } from '../runner-api/runner-api.controller';
import { renderRawQuery } from '../test-support/prisma-transaction-double';
import { RunnersController } from './runners.controller';
import { RunnersService } from './runners.service';

/**
 * Removing a runner's Default from Orbit, and bringing it back.
 *
 * Default is the directory the machine's own environment selects for an engine that keeps accounts
 * (~/.codex for Codex), the one that engine's CLI in a terminal there shares. `DELETE
 * /runners/:id/accounts/:engine/default` removes it from Orbit alone: the engine goes into
 * `runner.default_removed`, nothing on the machine changes and the runner is not asked, so the
 * answer is the removal done, at once — offline and on any runner version. It is refused while the
 * runner reports no other account of that engine. `POST …/default/restore` takes the engine back
 * out. What is checked here is everything decided around the two statements; the statements
 * themselves run on PostgreSQL in runner-default-remove.pg.spec.ts.
 */

const OWNER = 'owner-1';
const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const WORK = '3fa91c2e';
const USER = { userId: OWNER } as AuthUser;
const STRANGER = { userId: 'owner-2' } as AuthUser;

/** Every engine that keeps accounts, by the name the clients give it. */
const ENGINES: ReadonlyArray<[LoginEngine, string]> = [
  ['codex', 'Codex'],
  ['claude', 'Claude Code'],
  ['antigravity', 'Antigravity'],
  ['kimi', 'Kimi Code'],
  ['cursor', 'Cursor CLI'],
];

/** One engine as a runner reports it, with these accounts. */
function reported(engine: LoginEngine, ids: string[]): RunnerEngineHealth {
  return {
    engine,
    installed: true,
    auth: 'yes',
    accounts: ids.map((id) => ({
      id,
      home: id === 'default' ? `/home/ada/.${engine}` : `/home/ada/.orbit/${engine}-accounts/${id}`,
      auth: 'yes' as const,
    })),
  };
}

function harness(engines: unknown, row: Record<string, unknown> = {}) {
  const runner: Record<string, unknown> = {
    id: RUNNER_ID,
    ownerId: OWNER,
    status: 'ONLINE',
    capabilities: [CLAUDE_ACCOUNT_REMOVE_V1],
    capabilitiesReportedAt: new Date(),
    engines,
    ...row,
  };
  /** `runner.default_removed`, as the two statements leave it. */
  const removed: string[] = [];
  /** Every hand-written statement, and every relay write (`runner.update`). */
  const statements: { text: string; values: readonly unknown[] }[] = [];
  const relayWrites: Record<string, unknown>[] = [];
  const woken: string[] = [];
  const prisma = {
    runner: {
      findFirst: async ({ where }: { where: { id: string; ownerId: string } }) =>
        where.id === runner.id && where.ownerId === runner.ownerId ? { ...runner } : null,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        relayWrites.push(data);
        Object.assign(runner, data);
        return { ...runner };
      },
    },
    // The two statements as PostgreSQL runs them on this one row, by id and owner: the engine is
    // appended once, or taken out. Their real SQL runs in the pg spec.
    $executeRaw: async (...args: unknown[]) => {
      const { text, values } = renderRawQuery(args);
      statements.push({ text, values });
      const [engine] = values as string[];
      const [id, ownerId] = values.slice(-2);
      if (id !== runner.id || ownerId !== runner.ownerId) return 0;
      if (/array_append\("default_removed"/.test(text)) {
        if (!removed.includes(engine)) removed.push(engine);
      } else if (/array_remove\("default_removed"/.test(text)) {
        removed.splice(0, removed.length, ...removed.filter((entry) => entry !== engine));
      } else {
        throw new Error(`a statement this spec does not know: ${text}`);
      }
      return 1;
    },
  } as never;
  const realtime = { notifyRunnerWake: (id: string) => woken.push(id) } as never;
  const runners = new RunnersController(new RunnersService(prisma, realtime));
  return {
    runner,
    removed,
    statements,
    relayWrites,
    woken,
    /** DELETE /runners/:id/accounts/:engine/:account. Async, so the route's own refusal of an
     *  engine arrives as the rejection Nest answers it with. */
    remove: async (engine: string, account = 'default', user = USER) => runners.removeAccount(user, RUNNER_ID, engine, account),
    /** POST /runners/:id/accounts/:engine/default/restore. */
    restore: async (engine: string, user = USER) => runners.restoreDefault(user, RUNNER_ID, engine),
  };
}

/** The refusal the page shows, word for word. */
function refusedWith(message: string) {
  return (error: unknown) => {
    assert.ok(error instanceof BadRequestException, String(error));
    assert.equal((error.getResponse() as { message?: string }).message, message);
    return true;
  };
}

test('Default is removed from Orbit, and answered done at once, for every engine that keeps accounts', async () => {
  for (const [engine] of ENGINES) {
    const h = harness([reported(engine, ['default', WORK])]);

    assert.deepEqual(await h.remove(engine), { engine, account: 'default', status: 'done', message: null }, engine);

    assert.deepEqual(h.removed, [engine], `${engine}: the engine is recorded`);
    assert.equal(h.statements.length, 1, `${engine}: one statement`);
    assert.deepEqual(h.statements[0].values.slice(-2), [RUNNER_ID, OWNER], `${engine}: by this runner and its owner`);
    // Nothing goes to the machine: no relay row for the heartbeat to hand over, and no wake.
    assert.deepEqual(h.relayWrites, [], `${engine}: the account-removal relay is not written`);
    assert.equal(h.runner.codexAccountRemoveStatus, undefined);
    assert.deepEqual(h.woken, [], `${engine}: the runner is not woken`);
  }
});

test('the runner takes no part: an offline runner too old to remove any account is answered the same', async () => {
  const h = harness([reported('codex', ['default', WORK]), reported('claude', ['default', WORK])], {
    status: 'OFFLINE',
    lastHeartbeatAt: new Date('2026-01-01T00:00:00Z'),
    version: '0.1.100',
    capabilities: [],
    capabilitiesReportedAt: null,
  });

  assert.deepEqual(await h.remove('codex'), { engine: 'codex', account: 'default', status: 'done', message: null });
  assert.deepEqual(await h.remove('claude'), { engine: 'claude', account: 'default', status: 'done', message: null });
  assert.deepEqual(await h.restore('codex'), { ok: true });

  assert.deepEqual(h.removed, ['claude']);
  assert.deepEqual(h.relayWrites, []);
  assert.deepEqual(h.woken, []);
  // An added account on the same runner still needs the machine to remove it, and this one cannot.
  await assert.rejects(h.remove('codex', WORK), refusedWith('This runner is too old to remove a Codex account — update it, then try again.'));
});

test('with no other account of that engine, Default is refused in words that say to add one first', async () => {
  for (const [engine, name] of ENGINES) {
    const refusal = refusedWith(`Add another ${name} account to this machine before removing Default.`);
    const other: LoginEngine = engine === 'codex' ? 'claude' : 'codex';
    for (const [shape, engines] of [
      ['only Default reported', [reported(engine, ['default'])]],
      ['the engine reports no accounts', [{ engine, installed: true, auth: 'yes' }]],
      ['the engine is not reported', [reported(other, ['default', WORK])]],
      // Another engine's added account is no account of this one.
      ['only another engine has an added account', [reported(engine, ['default']), reported(other, ['default', WORK])]],
      ['the runner has never reported', null],
    ] as const) {
      const h = harness(engines);
      await assert.rejects(h.remove(engine), refusal, `${engine}: ${shape}`);
      assert.deepEqual(h.statements, [], `${engine}: ${shape}: nothing is written`);
      assert.deepEqual(h.relayWrites, []);
      assert.deepEqual(h.woken, []);
    }
  }
});

test('another account is all it takes, whether or not the runner lists Default itself', async () => {
  // A runner that lists the added account alone still has one other than Default.
  const h = harness([reported('kimi', [WORK])]);
  assert.equal((await h.remove('kimi')).status, 'done');
  assert.deepEqual(h.removed, ['kimi']);
});

test('removing Default twice, and bringing back one that is not removed, answer the same', async () => {
  const h = harness([reported('codex', ['default', WORK]), reported('cursor', ['default', WORK])]);

  assert.deepEqual(await h.restore('codex'), { ok: true }, 'a Default never removed comes back as it is');
  assert.deepEqual(h.removed, []);

  const done = { engine: 'codex', account: 'default', status: 'done', message: null };
  assert.deepEqual(await h.remove('codex'), done);
  assert.deepEqual(await h.remove('codex'), done, 'asked again, the same answer and no refusal');
  assert.deepEqual(h.removed, ['codex'], 'and the engine is recorded once');

  await h.remove('cursor');
  assert.deepEqual(await h.restore('codex'), { ok: true });
  assert.deepEqual(await h.restore('codex'), { ok: true });
  assert.deepEqual(h.removed, ['cursor'], 'restoring one engine leaves the other removed');
  assert.equal(h.statements.length, 6, 'each request is one statement');
  assert.deepEqual(h.relayWrites, []);
  assert.deepEqual(h.woken, []);
});

test('somebody else’s runner is not found, either way, and nothing of it is written', async () => {
  const h = harness([reported('codex', ['default', WORK])]);
  await h.remove('codex');

  await assert.rejects(h.remove('codex', 'default', STRANGER), NotFoundException);
  await assert.rejects(h.restore('codex', STRANGER), NotFoundException);

  assert.deepEqual(h.removed, ['codex'], 'the owner’s record is untouched');
  // The removal is refused before any statement; the restore's one statement matched no row.
  assert.equal(h.statements.length, 2);
  assert.deepEqual(h.statements[1].values.slice(-2), [RUNNER_ID, STRANGER.userId]);
});

test('an added account is still removed by the runner, as before', async () => {
  const h = harness([reported('claude', ['default', WORK])]);

  assert.deepEqual(await h.remove('claude', WORK), { engine: 'claude', account: WORK, status: 'pending', message: null });

  assert.equal(h.relayWrites.length, 1);
  assert.equal(h.runner.codexAccountRemoveAccount, WORK);
  assert.deepEqual(h.woken, [RUNNER_ID]);
  assert.deepEqual(h.statements, [], 'and Default is not recorded as removed');
  assert.deepEqual(h.removed, []);
});

test('both routes take only an engine that keeps accounts', async () => {
  const h = harness([reported('codex', ['default', WORK])]);
  for (const engine of ['opencode', 'dsh', 'Codex', '']) {
    await assert.rejects(h.remove(engine), BadRequestException, `DELETE ${JSON.stringify(engine)}`);
    await assert.rejects(h.restore(engine), BadRequestException, `restore ${JSON.stringify(engine)}`);
  }
  assert.deepEqual(h.statements, []);
});
