import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from 'pg';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

/**
 * 0426 against a real server: `cursor` stops being a slug anybody's key, pool or retired name can hold,
 * and becomes the seventh engine.
 *
 * Whatever held the slug moves to the first `cursor-N` free in all three tables of the dispatch
 * namespace, and every stored reference moves with it — including the ones 0367 had no reason to know
 * (an old OpenCode model naming the key, the `<engine>:<provider>` preference keys). A compatibility row
 * then takes the slug for good, and the engine checks admit `cursor`.
 *
 * Each move case puts the database back where 0426 found it — its guard row, CHECK, functions and
 * triggers gone, and 0414's engine checks as they were — seeds the world it has to handle, and replays
 * the migration file verbatim, so what is proven is the shipped SQL on PostgreSQL. Destructive: it
 * needs a database of its own (scripts/run-pg-spec.sh clones one per spec), and a missing server is a
 * failure, not a skip: this is the task's mandatory evidence (scripts/test-cursor-engine.mjs).
 */

const PG_URL = process.env.COORDINATOR_PG_URL;

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
const MIGRATION = readFileSync(path.join(MIGRATIONS, '0426_cursor_engine', 'migration.sql'), 'utf8');
const GUARD_ID = '00000000-0000-7000-8000-000000000426';
const GUARD_CIPHERTEXT = 'orbit-cursor-compatibility-guard';
const SIX = "'claude', 'codex', 'kimi', 'antigravity', 'opencode', 'dsh'";

/** A driver error carrying this SQLSTATE (and, when given, naming this constraint). */
const pgError = (code: string, constraint?: string) => (e: unknown) => {
  const error = e as { code?: string; constraint?: string };
  assert.equal(error.code, code, String(e));
  if (constraint) assert.equal(error.constraint, constraint, String(e));
  return true;
};

/** Back to the database 0426 found: none of what it installs, and 0414's engine checks. */
async function before0426(sql: Client): Promise<void> {
  await sql.query('DROP TRIGGER IF EXISTS model_provider_builtin_cursor_guard_delete ON model_provider');
  await sql.query('DROP TRIGGER IF EXISTS model_provider_builtin_cursor_guard_rename ON model_provider');
  await sql.query('DROP TRIGGER IF EXISTS session_cursor_runner_acquisition_guard ON session');
  await sql.query('DROP FUNCTION IF EXISTS protect_builtin_cursor_provider_guard()');
  await sql.query('DROP FUNCTION IF EXISTS guard_cursor_runner_acquisition()');
  await sql.query('ALTER TABLE model_provider DROP CONSTRAINT IF EXISTS model_provider_builtin_cursor_guard_shape');
  await sql.query('DELETE FROM model_provider WHERE id = $1', [GUARD_ID]);
  for (const table of ['session', 'task']) {
    await sql.query(
      `ALTER TABLE "${table}" DROP CONSTRAINT "${table}_engine_check", ADD CONSTRAINT "${table}_engine_check"
         CHECK ("engine" IS NULL OR "engine" IN (${SIX}))`,
    );
  }
}

test('P1 cursor engine migration on PostgreSQL', { concurrency: 1, timeout: 300_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const sql = new Client({ connectionString: PG_URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  t.after(() => sql.end().catch(() => undefined));

  const one = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await sql.query<T>(text, values)).rows[0];

  const newUser = async (preferences: unknown = {}) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "user" (id, email, name, password_hash, preferences) VALUES ($1, $2, 'cursor', 'x', $3)`,
      [id, `cursor-0426-${id}@example.invalid`, JSON.stringify(preferences)],
    );
    return id;
  };
  const newProvider = async (slug: string, ownerId: string | null) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO model_provider (id, slug, label, runtime, base_url, api_key_enc, owner_id, updated_at)
       VALUES ($1, $2, 'Cursor', 'claude', 'https://api.deepseek.com/anthropic', 'iv:tag:ct', $3, now())`,
      [id, slug, ownerId],
    );
    return id;
  };
  const newPool = async (slug: string, ownerId: string) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO provider_pool (id, slug, label, owner_id, updated_at) VALUES ($1, $2, 'Pool', $3, now())`,
      [id, slug, ownerId],
    );
    return id;
  };
  const newAlias = (slug: string, providerId: string) => sql.query(
    `INSERT INTO provider_slug_alias (slug, provider_id, engine, reason) VALUES ($1, $2, 'dsh', 'RENAMED')`,
    [slug, providerId],
  );
  const newSession = async (
    ownerId: string, provider: string, opts: { engine?: string | null; model?: string | null; status?: string } = {},
  ) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO session (id, title, prompt, owner_id, creator_id, provider, engine, model, status, updated_at)
       VALUES ($1, 'cursor', 'cursor', $2, $2, $3, $4, $5, $6::run_status, now())`,
      [id, ownerId, provider, opts.engine ?? null, opts.model ?? null, opts.status ?? 'AWAITING_INPUT'],
    );
    return id;
  };
  const newTask = async (ownerId: string, provider: string | null, opts: { engine?: string | null; model?: string | null } = {}) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO task (id, title, owner_id, creator_type, creator_id, completion_criterion, provider, engine, model, updated_at)
       VALUES ($1, 'cursor', $2, 'USER', $2, 'OWNER_CONFIRMED', $3, $4, $5, now())`,
      [id, ownerId, provider, opts.engine ?? null, opts.model ?? null],
    );
    return id;
  };
  const rowOf = async (table: 'session' | 'task', id: string) =>
    one<{ provider: string | null; engine: string | null; model: string | null }>(
      `SELECT provider, engine, model FROM ${table} WHERE id = $1`, [id],
    );
  const slugsHolding = async (slug: string) => ({
    providers: (await sql.query('SELECT id FROM model_provider WHERE slug = $1', [slug])).rows.map((r) => r.id),
    pools: (await sql.query('SELECT id FROM provider_pool WHERE slug = $1', [slug])).rows.map((r) => r.id),
    aliases: (await sql.query('SELECT provider_id FROM provider_slug_alias WHERE slug = $1', [slug])).rows.map((r) => r.provider_id),
  });
  const guardHolds = async () =>
    assert.deepEqual(await slugsHolding('cursor'), { providers: [GUARD_ID], pools: [], aliases: [] });

  await t.test('P1 a database every migration ran on carries the cursor fence', async () => {
    const onDisk = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const applied = (await sql.query<{ name: string }>(
      'SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    )).rows.map((row) => row.name).sort();
    assert.deepEqual(applied, onDisk, 'this is not a database every migration has run on');
    assert.ok(applied.includes('0426_cursor_engine'));
    assert.deepEqual(
      await one('SELECT slug, label, runtime, enabled, owner_id, api_key_enc FROM model_provider WHERE id = $1', [GUARD_ID]),
      {
        slug: 'cursor',
        label: '__orbit_builtin_cursor_guard__',
        runtime: 'claude',
        enabled: true,
        owner_id: null,
        api_key_enc: GUARD_CIPHERTEXT,
      },
    );
  });

  // Seeded once and read by the cases below. Ann's last picks name the key under every form a
  // preference key or an OpenCode value can take; Ben's and Carl's must not move.
  const ann = await newUser({
    theme: 'dark',
    defaultModels: {
      cursor: 'deepseek-chat',
      'claude:cursor': 'deepseek-reasoner',
      'opencode:cursor': 'deepseek-chat',
      'opencode/cursor': 'orbit-cursor/deepseek-chat',
      opencode: 'orbit-cursor/deepseek-reasoner',
      claude: 'claude-opus-5',
      // Stale, under the name the key is about to take: the moved pick wins over it.
      'cursor-5': 'stale-model',
    },
  });
  const ben = await newUser({
    defaultModels: {
      claude: 'claude-sonnet-5', 'codex:cursor-2': 'gpt-5.6-sol', 'opencode/cursor-2': 'orbit-cursor-2/x',
      opencode: 'anthropic/claude-sonnet-5',
    },
  });
  const carl = await newUser({ defaultModels: ['cursor'] });

  await t.test('P1 a key named cursor moves aside with its sessions, tasks, preferences and every other reference', async () => {
    await before0426(sql);
    const held = await newProvider('cursor', ann);
    const second = await newProvider('cursor-2', ann);
    await newPool('cursor-3', ann);
    await newAlias('cursor-4', second);

    // A Claude Code session on the key (its engine recorded), and an OpenCode one naming it the old way.
    const session = await newSession(ann, 'cursor', { engine: 'claude', model: 'deepseek-chat' });
    const openCodeSession = await newSession(ann, 'opencode', { engine: 'opencode', model: 'orbit-cursor/deepseek-chat' });
    const claudeSession = await newSession(ann, 'claude', { engine: 'claude', model: 'claude-opus-5' });
    const otherKeySession = await newSession(ann, 'cursor-2', { engine: 'claude' });
    const task = await newTask(ann, 'cursor', { engine: 'claude', model: 'deepseek-chat' });
    const openCodeTask = await newTask(ann, 'opencode', { engine: 'opencode', model: 'orbit-cursor/deepseek-chat' });
    const otherTask = await newTask(ann, 'cursor-2', { engine: 'claude' });
    const decision = randomUUID();
    await sql.query(
      `INSERT INTO task_route_decision (id, owner_id, task_id, request_token, applied, policy_version,
                                        provider, baseline, features, reasons)
       VALUES ($1, $2, $3, 'run-1', false, 1, 'cursor', $4, '{}', ARRAY['shadow'])`,
      [decision, ann, task, JSON.stringify({ provider: 'cursor', providerSource: 'task-pin', model: null, engine: 'claude' })],
    );
    // A bound plan names the provider at three depths, and an OpenCode model naming the key; prose
    // that happens to read like either is not one. A completed plan is an answer, replayed as it is.
    const runTarget = {
      v: 2,
      kind: 'RUN',
      plan: { kind: 'CREATE', sessionId: randomUUID() },
      taskId: task,
      title: 'cursor',
      prompt: 'Keep "provider": "cursor" and "model": "orbit-cursor/x" in the config file',
      provider: 'cursor',
      model: null,
      route: { provider: 'cursor', baseline: { provider: 'cursor' }, reasons: [] },
    };
    const batchTarget = {
      v: 2,
      kind: 'BATCH',
      items: [
        { kind: 'CREATE', taskId: task, provider: 'cursor', route: { provider: 'cursor' } },
        { kind: 'CREATE', taskId: openCodeTask, provider: 'opencode', model: 'orbit-cursor/deepseek-chat', route: null },
        { kind: 'CREATE', taskId: otherTask, provider: 'claude', route: null },
      ],
    };
    for (const [token, status, target, result] of [
      ['bound-run', 'BOUND', runTarget, null],
      ['bound-batch', 'BOUND', batchTarget, null],
      ['completed-run', 'COMPLETED', runTarget, { sessionId: randomUUID() }],
    ] as const) {
      await sql.query(
        `INSERT INTO task_run_request (owner_id, action_kind, request_token, fingerprint, status, target, result)
         VALUES ($1, 'TASK_EXECUTE', $2, 'fp', $3, $4, $5)`,
        [ann, token, status, JSON.stringify(target), result ? JSON.stringify(result) : null],
      );
    }
    const workspace = randomUUID();
    await sql.query(
      `INSERT INTO workspace (id, name, owner_id, provider_fallbacks, model_routing_providers)
       VALUES ($1, 'cursor', $2, $3, ARRAY['codex', 'cursor'])`,
      [workspace, ann, JSON.stringify([{ provider: 'cursor', model: 'deepseek-chat' }, { provider: 'claude' }])],
    );
    const agent = randomUUID();
    await sql.query(
      `INSERT INTO agent (id, owner_id, name, default_provider, provider_fallbacks) VALUES ($1, $2, $3, 'cursor', $4)`,
      [agent, ann, `cursor-${agent}`, JSON.stringify([{ provider: 'claude' }, { provider: 'cursor' }])],
    );
    const space = randomUUID();
    await sql.query(
      `INSERT INTO wiki_space (id, owner_id, slug, title, settings) VALUES ($1, $2, $3, 'Cursor', $4)`,
      [space, ann, `cursor-${space.slice(0, 8)}`, JSON.stringify({ push: true, maintenance: { enabled: true, provider: 'cursor' } })],
    );

    await sql.query(MIGRATION);

    // The holder moved past the provider at -2, the pool at -3 and the retired name at -4.
    const moved = 'cursor-5';
    assert.deepEqual(await slugsHolding(moved), { providers: [held], pools: [], aliases: [] });
    await guardHolds();
    // Dispatch identities follow it, the engine beside each stays; nothing that named something else moves.
    assert.deepEqual(await rowOf('session', session), { provider: moved, engine: 'claude', model: 'deepseek-chat' });
    assert.deepEqual(await rowOf('session', openCodeSession), {
      provider: 'opencode', engine: 'opencode', model: `orbit-${moved}/deepseek-chat`,
    });
    assert.deepEqual(await rowOf('session', claudeSession), { provider: 'claude', engine: 'claude', model: 'claude-opus-5' });
    assert.equal((await rowOf('session', otherKeySession)).provider, 'cursor-2');
    assert.deepEqual(await rowOf('task', task), { provider: moved, engine: 'claude', model: 'deepseek-chat' });
    assert.deepEqual(await rowOf('task', openCodeTask), {
      provider: 'opencode', engine: 'opencode', model: `orbit-${moved}/deepseek-chat`,
    });
    assert.equal((await rowOf('task', otherTask)).provider, 'cursor-2');
    assert.deepEqual(
      await one('SELECT provider, baseline FROM task_route_decision WHERE id = $1', [decision]),
      { provider: moved, baseline: { provider: moved, providerSource: 'task-pin', model: null, engine: 'claude' } },
    );
    const target = async (token: string) =>
      (await one<{ target: Record<string, any> }>(
        'SELECT target FROM task_run_request WHERE owner_id = $1 AND request_token = $2', [ann, token],
      )).target;
    const run = await target('bound-run');
    assert.equal(run.provider, moved);
    assert.equal(run.route.provider, moved);
    assert.equal(run.route.baseline.provider, moved);
    assert.equal(run.prompt, 'Keep "provider": "cursor" and "model": "orbit-cursor/x" in the config file');
    const batch = await target('bound-batch');
    assert.deepEqual(batch.items.map((item: { provider: string }) => item.provider), [moved, 'opencode', 'claude']);
    assert.equal(batch.items[0].route.provider, moved);
    assert.equal(batch.items[1].model, `orbit-${moved}/deepseek-chat`);
    assert.equal((await target('completed-run')).provider, 'cursor');
    assert.deepEqual(
      await one('SELECT provider_fallbacks, model_routing_providers FROM workspace WHERE id = $1', [workspace]),
      {
        provider_fallbacks: [{ provider: moved, model: 'deepseek-chat' }, { provider: 'claude' }],
        model_routing_providers: ['codex', moved],
      },
    );
    assert.deepEqual(
      await one('SELECT default_provider, provider_fallbacks FROM agent WHERE id = $1', [agent]),
      { default_provider: moved, provider_fallbacks: [{ provider: 'claude' }, { provider: moved }] },
    );
    // Every form of key moves, each value with it; an `opencode` pick naming the key names its new slug.
    assert.deepEqual((await one('SELECT preferences FROM "user" WHERE id = $1', [ann])).preferences, {
      theme: 'dark',
      defaultModels: {
        [moved]: 'deepseek-chat',
        [`claude:${moved}`]: 'deepseek-reasoner',
        [`opencode:${moved}`]: 'deepseek-chat',
        [`opencode/${moved}`]: `orbit-${moved}/deepseek-chat`,
        opencode: `orbit-${moved}/deepseek-reasoner`,
        claude: 'claude-opus-5',
      },
    });
    assert.deepEqual((await one('SELECT preferences FROM "user" WHERE id = $1', [ben])).preferences, {
      defaultModels: {
        claude: 'claude-sonnet-5', 'codex:cursor-2': 'gpt-5.6-sol', 'opencode/cursor-2': 'orbit-cursor-2/x',
        opencode: 'anthropic/claude-sonnet-5',
      },
    });
    assert.deepEqual((await one('SELECT preferences FROM "user" WHERE id = $1', [carl])).preferences, { defaultModels: ['cursor'] });
    assert.deepEqual(
      (await one('SELECT settings FROM wiki_space WHERE id = $1', [space])).settings,
      { push: true, maintenance: { enabled: true, provider: moved } },
    );
  });

  await t.test('P1 an account pool or a retired name holding cursor moves aside, and the guard row then takes it', async () => {
    await before0426(sql);
    const pool = await newPool('cursor', ann);
    const pooled = await newSession(ann, 'cursor', { engine: 'claude' });
    const pinned = await newTask(ann, 'cursor', { engine: 'claude' });

    await sql.query(MIGRATION);

    // -2, -4 (an alias) and -5 are taken and -3 is a pool, so the first suffix free in all three is -6.
    assert.deepEqual(await slugsHolding('cursor-6'), { providers: [], pools: [pool], aliases: [] });
    assert.equal((await rowOf('session', pooled)).provider, 'cursor-6');
    assert.equal((await rowOf('task', pinned)).provider, 'cursor-6');
    await guardHolds();

    await before0426(sql);
    const key = (await slugsHolding('cursor-2')).providers[0];
    await newAlias('cursor', key);
    const aliased = await newSession(ann, 'cursor', { engine: 'dsh' });

    await sql.query(MIGRATION);

    // The retired name keeps resolving to the same key, under its new slug.
    assert.deepEqual(await slugsHolding('cursor-7'), { providers: [], pools: [], aliases: [key] });
    assert.deepEqual(await rowOf('session', aliased), { provider: 'cursor-7', engine: 'dsh', model: null });
    await guardHolds();
  });

  await t.test('P1 a reference whose holder was deleted keeps meaning it, not Cursor CLI', async () => {
    await before0426(sql);
    // Nothing holds the slug any more, but these still name the deleted key that did.
    const session = await newSession(ann, 'cursor', { engine: 'claude' });
    const task = await newTask(ann, 'cursor');

    await sql.query(MIGRATION);

    // Moved to a suffix nothing holds: it resolves to nothing exactly as `cursor` did.
    assert.equal((await rowOf('session', session)).provider, 'cursor-8');
    assert.equal((await rowOf('task', task)).provider, 'cursor-8');
    assert.deepEqual(await slugsHolding('cursor-8'), { providers: [], pools: [], aliases: [] });
    await guardHolds();
  });

  await t.test('P1 on a database where nothing held cursor, the migration only adds the fence', async () => {
    await before0426(sql);
    const untouched = await newSession(ann, 'cursor-8', { engine: 'claude' });

    await sql.query(MIGRATION);

    assert.equal((await rowOf('session', untouched)).provider, 'cursor-8');
    await guardHolds();
    const triggers = (await sql.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%cursor%' ORDER BY 1`,
    )).rows.map((row) => row.tgname);
    assert.deepEqual(triggers, [
      'model_provider_builtin_cursor_guard_delete',
      'model_provider_builtin_cursor_guard_rename',
      'session_cursor_runner_acquisition_guard',
    ]);
  });

  await t.test('P1 the reserved cursor row refuses removal, renaming and disabling, and no new key, pool or name can take cursor', async () => {
    await assert.rejects(sql.query('DELETE FROM model_provider WHERE id = $1', [GUARD_ID]), pgError('23514'));
    await assert.rejects(sql.query(`UPDATE model_provider SET slug = 'cursor-x' WHERE id = $1`, [GUARD_ID]), pgError('23514'));
    await assert.rejects(
      sql.query('UPDATE model_provider SET enabled = false WHERE id = $1', [GUARD_ID]),
      pgError('23514', 'model_provider_builtin_cursor_guard_shape'),
    );
    // Cosmetic columns stay writable, so table-wide maintenance is not turned into an error.
    await sql.query('UPDATE model_provider SET label = label WHERE id = $1', [GUARD_ID]);
    // An older replica's slug picker already skips the name, since the row holds it. A write of it anyway
    // is refused: a key by the shape CHECK, a pool or a retired name by the dispatch-slug guard.
    await assert.rejects(newProvider('cursor', ann), pgError('23514', 'model_provider_builtin_cursor_guard_shape'));
    await assert.rejects(newProvider('cursor', null), pgError('23514', 'model_provider_builtin_cursor_guard_shape'));
    await assert.rejects(newPool('cursor', ann), pgError('23505', 'provider_dispatch_slug_key'));
    const key = (await slugsHolding('cursor-2')).providers[0];
    await assert.rejects(newAlias('cursor', key), pgError('23505', 'provider_dispatch_slug_key'));
    await assert.rejects(
      sql.query(`UPDATE provider_pool SET slug = 'cursor' WHERE slug = 'cursor-6'`),
      pgError('23505', 'provider_dispatch_slug_key'),
    );
    await guardHolds();
  });

  await t.test('P1 the engine checks accept cursor on sessions and tasks and refuse an unknown engine', async () => {
    for (const engine of ['claude', 'codex', 'kimi', 'antigravity', 'opencode', 'dsh', 'cursor']) {
      const session = await newSession(ann, engine === 'cursor' ? 'cursor' : 'claude', { engine });
      assert.equal((await rowOf('session', session)).engine, engine);
      const task = await newTask(ann, null, { engine });
      assert.equal((await rowOf('task', task)).engine, engine);
    }
    // Recorded once, on an unrecorded row, as a claim records it (§1.1).
    const unrecorded = await newSession(ann, 'cursor');
    await sql.query(`UPDATE session SET engine = 'cursor' WHERE id = $1`, [unrecorded]);
    assert.equal((await rowOf('session', unrecorded)).engine, 'cursor');
    for (const unknown of ['cursor-cli', 'Cursor', 'agent', 'gpt']) {
      await assert.rejects(newSession(ann, 'claude', { engine: unknown }), pgError('23514', 'session_engine_check'));
      await assert.rejects(newTask(ann, null, { engine: unknown }), pgError('23514', 'task_engine_check'));
      const pin = await newTask(ann, null);
      await assert.rejects(sql.query('UPDATE task SET engine = $2 WHERE id = $1', [pin, unknown]), pgError('23514', 'task_engine_check'));
    }
    // And a recorded Cursor CLI session stays one (0414's immutability holds for the new value).
    await assert.rejects(
      sql.query(`UPDATE session SET engine = 'claude' WHERE id = $1`, [unrecorded]),
      pgError('23514', 'session_engine_immutable'),
    );
  });
});
