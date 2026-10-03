import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from 'pg';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

/**
 * 0367 against a real server: `antigravity` stops being a slug anybody's provider can hold.
 *
 * What it has to do is easy to state and easy to get partly right. Whatever held the slug — a
 * configured provider, or since 0265 an account pool — moves to the first `antigravity-N` free in
 * BOTH tables, and every stored reference moves with it, in every column that can hold a dispatch
 * slug (the migration's header lists them, and why each). Then a compatibility row takes the slug
 * for good, and the session trigger keeps an older control plane's claim off Antigravity rows.
 *
 * Each case puts the database back where 0367 found it — its guard row, CHECK, functions and
 * triggers gone — seeds the world it has to handle, and replays the migration file verbatim. So
 * what is proven is the shipped SQL on PostgreSQL, not a description of it.
 *
 * Needs COORDINATOR_PG_URL (scripts/run-pg-spec.sh provides a disposable one); without it every case
 * reports as skipped, and that script counts a skip as red. Destructive: it needs a database of its
 * own, and leaves the rows it seeds behind.
 */

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;

const MIGRATIONS = path.resolve(__dirname, '../../prisma/migrations');
const MIGRATION = readFileSync(path.join(MIGRATIONS, '0367_antigravity_runtime', 'migration.sql'), 'utf8');
const GUARD_ID = '00000000-0000-7000-8000-000000000367';
const GUARD_CIPHERTEXT = 'orbit-antigravity-compatibility-guard';

/** A driver error carrying this SQLSTATE (and, when given, naming this constraint). */
const pgError = (code: string, constraint?: string) => (e: unknown) => {
  const error = e as { code?: string; constraint?: string };
  assert.equal(error.code, code, String(e));
  if (constraint) assert.equal(error.constraint, constraint, String(e));
  return true;
};

/** Back to the database 0367 found: none of what it installs, and nothing holding the slug for it. */
async function before0367(sql: Client): Promise<void> {
  await sql.query('DROP TRIGGER IF EXISTS model_provider_builtin_antigravity_guard_delete ON model_provider');
  await sql.query('DROP TRIGGER IF EXISTS model_provider_builtin_antigravity_guard_rename ON model_provider');
  await sql.query('DROP TRIGGER IF EXISTS session_antigravity_runner_claim_guard ON session');
  await sql.query('DROP FUNCTION IF EXISTS protect_builtin_antigravity_provider_guard()');
  await sql.query('DROP FUNCTION IF EXISTS guard_antigravity_runner_claim()');
  await sql.query(
    'ALTER TABLE model_provider DROP CONSTRAINT IF EXISTS model_provider_builtin_antigravity_guard_shape',
  );
  await sql.query('DELETE FROM model_provider WHERE id = $1', [GUARD_ID]);
}

test('0367 moves whatever held `antigravity` aside and reserves the name', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = PG_URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  t.after(() => sql.end().catch(() => undefined));

  const one = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await sql.query<T>(text, values)).rows[0];

  const newUser = async (preferences: unknown = {}) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO "user" (id, email, name, password_hash, preferences) VALUES ($1, $2, 'agy', 'x', $3)`,
      [id, `agy-0367-${id}@example.invalid`, JSON.stringify(preferences)],
    );
    return id;
  };
  const newProvider = async (slug: string, ownerId: string | null) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO model_provider (id, slug, label, runtime, base_url, api_key_enc, owner_id, updated_at)
       VALUES ($1, $2, 'Antigravity', 'claude', 'https://gemini.example.invalid', 'iv:tag:ct', $3, now())`,
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
  const newSession = async (ownerId: string, provider: string, status = 'AWAITING_INPUT') => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO session (id, title, prompt, owner_id, creator_id, provider, status, updated_at)
       VALUES ($1, 'agy', 'agy', $2, $2, $3, $4::run_status, now())`,
      [id, ownerId, provider, status],
    );
    return id;
  };
  const newTask = async (ownerId: string, provider: string | null) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO task (id, title, owner_id, creator_type, creator_id, completion_criterion, provider, updated_at)
       VALUES ($1, 'agy', $2, 'USER', $2, 'OWNER_CONFIRMED', $3, now())`,
      [id, ownerId, provider],
    );
    return id;
  };
  const providerOf = async (table: 'session' | 'task', id: string) =>
    (await one<{ provider: string | null }>(`SELECT provider FROM ${table} WHERE id = $1`, [id])).provider;
  const slugsHolding = async (slug: string) => ({
    providers: (await sql.query('SELECT id FROM model_provider WHERE slug = $1', [slug])).rows.map((r) => r.id),
    pools: (await sql.query('SELECT id FROM provider_pool WHERE slug = $1', [slug])).rows.map((r) => r.id),
  });

  await t.test('a database every migration ran on carries the fence', async () => {
    const onDisk = readdirSync(MIGRATIONS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const applied = (await sql.query<{ name: string }>(
      'SELECT migration_name AS name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    )).rows.map((row) => row.name).sort();
    assert.deepEqual(applied, onDisk, 'this is not a database every migration has run on');
    const guard = await one(
      'SELECT slug, label, runtime, enabled, owner_id, api_key_enc FROM model_provider WHERE id = $1',
      [GUARD_ID],
    );
    assert.deepEqual(guard, {
      slug: 'antigravity',
      label: '__orbit_builtin_antigravity_guard__',
      runtime: 'claude',
      enabled: true,
      owner_id: null,
      api_key_enc: GUARD_CIPHERTEXT,
    });
  });

  // Seeded once and read by the cases below: the provider that held the slug before 0367, and the
  // suffixes already taken in each half of the namespace — so the move has to skip both.
  const ann = await newUser({
    theme: 'dark',
    defaultModels: { antigravity: 'deepseek-chat', claude: 'claude-opus-5' },
  });
  const ben = await newUser({ defaultModels: { claude: 'claude-sonnet-5' } });

  await t.test('a configured provider called antigravity moves aside with every reference to it', async () => {
    await before0367(sql);
    const held = await newProvider('antigravity', ann);
    await newProvider('antigravity-2', ann);
    await newPool('antigravity-3', ann);

    const session = await newSession(ann, 'antigravity');
    const claudeSession = await newSession(ann, 'claude');
    const task = await newTask(ann, 'antigravity');
    const otherTask = await newTask(ann, 'antigravity-2');
    const decision = randomUUID();
    await sql.query(
      `INSERT INTO task_route_decision (id, owner_id, task_id, request_token, applied, policy_version,
                                        provider, baseline, features, reasons)
       VALUES ($1, $2, $3, 'run-1', false, 1, 'antigravity', $4, '{}', ARRAY['shadow'])`,
      [decision, ann, task, JSON.stringify({ provider: 'antigravity', providerSource: 'task-pin', model: null })],
    );
    // A bound plan names the provider at three depths, in both shapes; a completed one is an answer.
    const runTarget = {
      v: 2,
      kind: 'RUN',
      plan: { kind: 'CREATE', sessionId: randomUUID() },
      taskId: task,
      title: 'agy',
      // Prose that happens to contain the words is not a provider.
      prompt: 'Keep "provider": "antigravity" in the config file',
      provider: 'antigravity',
      model: null,
      route: { provider: 'antigravity', baseline: { provider: 'antigravity' }, reasons: [] },
    };
    const batchTarget = {
      v: 2,
      kind: 'BATCH',
      items: [
        { kind: 'CREATE', taskId: task, provider: 'antigravity', route: { provider: 'antigravity' } },
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
       VALUES ($1, 'agy', $2, $3, ARRAY['codex', 'antigravity'])`,
      [workspace, ann, JSON.stringify([{ provider: 'antigravity', model: 'deepseek-chat' }, { provider: 'claude' }])],
    );
    const agent = randomUUID();
    await sql.query(
      `INSERT INTO agent (id, owner_id, name, default_provider, provider_fallbacks)
       VALUES ($1, $2, $3, 'antigravity', $4)`,
      [agent, ann, `agy-${agent}`, JSON.stringify([{ provider: 'claude' }, { provider: 'antigravity' }])],
    );
    const space = randomUUID();
    await sql.query(
      `INSERT INTO wiki_space (id, owner_id, slug, title, settings) VALUES ($1, $2, $3, 'Agy', $4)`,
      [space, ann, `agy-${space.slice(0, 8)}`, JSON.stringify({ push: true, maintenance: { enabled: true, provider: 'antigravity' } })],
    );

    await sql.query(MIGRATION);

    // The holder moved past the provider at -2 and the pool at -3, and the guard took its place.
    const moved = 'antigravity-4';
    assert.deepEqual(await slugsHolding(moved), { providers: [held], pools: [] });
    assert.deepEqual(await slugsHolding('antigravity'), { providers: [GUARD_ID], pools: [] });
    // Dispatch identities follow it; nothing that named something else moves.
    assert.equal(await providerOf('session', session), moved);
    assert.equal(await providerOf('session', claudeSession), 'claude');
    assert.equal(await providerOf('task', task), moved);
    assert.equal(await providerOf('task', otherTask), 'antigravity-2');
    assert.deepEqual(
      await one('SELECT provider, baseline FROM task_route_decision WHERE id = $1', [decision]),
      { provider: moved, baseline: { provider: moved, providerSource: 'task-pin', model: null } },
    );
    const target = async (token: string) =>
      (await one<{ target: Record<string, any> }>(
        'SELECT target FROM task_run_request WHERE owner_id = $1 AND request_token = $2',
        [ann, token],
      )).target;
    const run = await target('bound-run');
    assert.equal(run.provider, moved);
    assert.equal(run.route.provider, moved);
    assert.equal(run.route.baseline.provider, moved);
    assert.equal(run.prompt, 'Keep "provider": "antigravity" in the config file');
    const batch = await target('bound-batch');
    assert.deepEqual(batch.items.map((item: { provider: string }) => item.provider), [moved, 'claude']);
    assert.equal(batch.items[0].route.provider, moved);
    // An answer already given is replayed byte for byte, never acted on: left as it was.
    assert.equal((await target('completed-run')).provider, 'antigravity');
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
    assert.deepEqual(
      (await one('SELECT preferences FROM "user" WHERE id = $1', [ann])).preferences,
      { theme: 'dark', defaultModels: { [moved]: 'deepseek-chat', claude: 'claude-opus-5' } },
    );
    assert.deepEqual(
      (await one('SELECT preferences FROM "user" WHERE id = $1', [ben])).preferences,
      { defaultModels: { claude: 'claude-sonnet-5' } },
    );
    assert.deepEqual(
      (await one('SELECT settings FROM wiki_space WHERE id = $1', [space])).settings,
      { push: true, maintenance: { enabled: true, provider: moved } },
    );
  });

  await t.test('the reserved row cannot be removed, renamed, disabled or shadowed', async () => {
    await assert.rejects(sql.query('DELETE FROM model_provider WHERE id = $1', [GUARD_ID]), pgError('23514'));
    await assert.rejects(
      sql.query(`UPDATE model_provider SET slug = 'antigravity-x' WHERE id = $1`, [GUARD_ID]),
      pgError('23514'),
    );
    await assert.rejects(
      sql.query('UPDATE model_provider SET enabled = false WHERE id = $1', [GUARD_ID]),
      pgError('23514', 'model_provider_builtin_antigravity_guard_shape'),
    );
    // Cosmetic columns stay writable, so table-wide maintenance is not turned into an error.
    await sql.query(`UPDATE model_provider SET label = label WHERE id = $1`, [GUARD_ID]);
    // An older replica's slug picker already skips the name, since the row holds it. A write of it
    // anyway is refused: a provider by the shape CHECK (checked before the unique index), a pool by
    // 0265's dispatch-slug guard.
    await assert.rejects(
      newProvider('antigravity', ann),
      pgError('23514', 'model_provider_builtin_antigravity_guard_shape'),
    );
    await assert.rejects(newPool('antigravity', ann), pgError('23505', 'provider_dispatch_slug_key'));
  });

  await t.test('only a claim that declares the Antigravity capability starts an Antigravity row', async () => {
    const claim = async (id: string, settings: string) => {
      await sql.query('BEGIN');
      try {
        if (settings) await sql.query(`SELECT ${settings}`);
        const claimed = await sql.query(
          `UPDATE session SET status = 'RUNNING' WHERE id = $1 AND status = 'PENDING' RETURNING id`,
          [id],
        );
        await sql.query('COMMIT');
        return claimed.rowCount;
      } catch (e) {
        await sql.query('ROLLBACK');
        throw e;
      }
    };
    const agy = await newSession(ann, 'antigravity', 'PENDING');
    // An older replica's claim sets nothing; the OpenCode-era one sets only its own capability.
    assert.equal(await claim(agy, ''), 0);
    assert.equal(await claim(agy, `set_config('orbit.runner_supports_opencode', '1', true)`), 0);
    assert.equal((await one('SELECT status FROM session WHERE id = $1', [agy])).status, 'PENDING');
    // What QueueService.trySessionClaim sets for a runner that advertises `antigravity`.
    assert.equal(
      await claim(
        agy,
        `set_config('orbit.runner_supports_opencode', '0', true), set_config('orbit.runner_supports_antigravity', '1', true)`,
      ),
      1,
    );
    // The capability is transaction-local: it does not leak to the next statement.
    const again = await newSession(ann, 'antigravity', 'PENDING');
    assert.equal(await claim(again, ''), 0);
    // Nothing else is touched: a Claude row claims as it always did, and an Antigravity row that is
    // already running parks without any capability.
    assert.equal(await claim(await newSession(ann, 'claude', 'PENDING'), ''), 1);
    await sql.query(`UPDATE session SET status = 'AWAITING_INPUT' WHERE id = $1`, [agy]);
    assert.equal((await one('SELECT status FROM session WHERE id = $1', [agy])).status, 'AWAITING_INPUT');
  });

  await t.test('an account pool holding the slug moves aside, and the guard row then takes it', async () => {
    await before0367(sql);
    const pool = await newPool('antigravity', ann);
    const session = await newSession(ann, 'antigravity');

    await sql.query(MIGRATION);

    // -2 and -4 are providers and -3 a pool, so the first suffix free in both tables is -5.
    assert.deepEqual(await slugsHolding('antigravity-5'), { providers: [], pools: [pool] });
    assert.equal(await providerOf('session', session), 'antigravity-5');
    assert.deepEqual(await slugsHolding('antigravity'), { providers: [GUARD_ID], pools: [] });
  });

  await t.test('a reference whose provider was deleted keeps meaning that provider, not agy', async () => {
    await before0367(sql);
    // Nothing holds the slug any more, but these still name the deleted provider that did.
    const session = await newSession(ann, 'antigravity');
    const task = await newTask(ann, 'antigravity');

    await sql.query(MIGRATION);

    // Moved to a suffix nothing holds: it resolves to nothing exactly as `antigravity` did — the
    // Claude fallback on the session, "provider not available" on the pin.
    assert.equal(await providerOf('session', session), 'antigravity-6');
    assert.equal(await providerOf('task', task), 'antigravity-6');
    assert.deepEqual(await slugsHolding('antigravity-6'), { providers: [], pools: [] });
    assert.deepEqual(await slugsHolding('antigravity'), { providers: [GUARD_ID], pools: [] });
  });

  await t.test('on a database where nothing held the slug, the migration only adds the fence', async () => {
    await before0367(sql);
    const untouched = await newSession(ann, 'antigravity-4');

    await sql.query(MIGRATION);

    assert.equal(await providerOf('session', untouched), 'antigravity-4');
    assert.deepEqual(await slugsHolding('antigravity'), { providers: [GUARD_ID], pools: [] });
    const triggers = (await sql.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%antigravity%' ORDER BY 1`,
    )).rows.map((row) => row.tgname);
    assert.deepEqual(triggers, [
      'model_provider_builtin_antigravity_guard_delete',
      'model_provider_builtin_antigravity_guard_rename',
      'session_antigravity_runner_claim_guard',
    ]);
  });
});
