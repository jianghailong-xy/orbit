import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from 'pg';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';

/**
 * 0372 against a real server: the Gemini preset's rows leave Codex for the Antigravity CLI.
 *
 * Each case seeds rows as a pre-0372 control plane wrote them — runtime `codex`, Google's
 * OpenAI-compatible base URL — and replays the migration file verbatim, so what is proven is the
 * shipped SQL on PostgreSQL. The migration is plain DML, so replaying it over a database that
 * already ran it is exactly what a second run would do.
 *
 * Needs COORDINATOR_PG_URL (scripts/run-pg-spec.sh provides a disposable one); without it every case
 * reports as skipped, and that script counts a skip as red. Destructive: it needs a database of its
 * own, and leaves the rows it seeds behind.
 */

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;

const MIGRATION = readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/0372_gemini_antigravity_runtime/migration.sql'),
  'utf8',
);
const COMPAT = 'https://generativelanguage.googleapis.com/v1beta/openai';

test('0372 moves the Gemini preset onto Antigravity', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = PG_URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  t.after(() => sql.end().catch(() => undefined));

  const one = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) =>
    (await sql.query<T>(text, values)).rows[0];

  const owner = randomUUID();
  await sql.query(
    `INSERT INTO "user" (id, email, name, password_hash) VALUES ($1, $2, 'gemini', 'x')`,
    [owner, `gemini-0372-${owner}@example.invalid`],
  );
  const newProvider = async (preset: string | null, runtime: string, baseUrl: string, enabled = true) => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO model_provider (id, slug, label, runtime, base_url, api_key_enc, preset_slug, owner_id, enabled, updated_at)
       VALUES ($1, $2, 'Gemini', $3, $4, 'iv:tag:ct', $5, $6, $7, now())`,
      [id, `p-0372-${id}`, runtime, baseUrl, preset, owner, enabled],
    );
    return id;
  };
  const providerRow = (id: string) =>
    one<{ slug: string; runtime: string; base_url: string }>(
      'SELECT slug, runtime, base_url FROM model_provider WHERE id = $1',
      [id],
    );
  const newSession = async (provider: string, runtimeSessionId: string | null, status = 'AWAITING_INPUT') => {
    const id = randomUUID();
    await sql.query(
      `INSERT INTO session (id, title, prompt, owner_id, creator_id, provider, runtime_session_id, status, updated_at)
       VALUES ($1, 'gemini', 'gemini', $2, $2, $3, $4, $5::run_status, now())`,
      [id, owner, provider, runtimeSessionId, status],
    );
    return id;
  };
  const runtimeSessionIdOf = async (id: string) =>
    (await one<{ runtime_session_id: string | null }>('SELECT runtime_session_id FROM session WHERE id = $1', [id]))
      .runtime_session_id;

  await t.test('a preset row gets the runtime and the bare host, with or without a trailing slash', async () => {
    const plain = await newProvider('gemini', 'codex', COMPAT);
    const slashed = await newProvider('gemini', 'codex', `${COMPAT}/`);

    await sql.query(MIGRATION);

    for (const id of [plain, slashed]) {
      const row = await providerRow(id);
      assert.equal(row.runtime, 'antigravity');
      // agy appends /v1beta/models/… itself; a base that kept /v1beta/openai would 404 every turn.
      assert.equal(row.base_url, 'https://generativelanguage.googleapis.com');
    }
  });

  await t.test('a hand-typed endpoint keeps its URL, and the runtime still flips', async () => {
    const proxied = await newProvider('gemini', 'codex', 'https://gemini-proxy.example.invalid/google');

    await sql.query(MIGRATION);

    const row = await providerRow(proxied);
    assert.equal(row.runtime, 'antigravity');
    assert.equal(row.base_url, 'https://gemini-proxy.example.invalid/google');
  });

  await t.test('rows of any other vendor, and a custom one on the same URL, are left alone', async () => {
    const openai = await newProvider('openai', 'codex', 'https://api.openai.com/v1');
    const custom = await newProvider(null, 'codex', COMPAT);

    await sql.query(MIGRATION);

    assert.deepEqual(
      { runtime: (await providerRow(openai)).runtime, base_url: (await providerRow(openai)).base_url },
      { runtime: 'codex', base_url: 'https://api.openai.com/v1' },
    );
    // The preset is the identity this follows; a row that never named it was set up by hand.
    assert.equal((await providerRow(custom)).runtime, 'codex');
    assert.equal((await providerRow(custom)).base_url, COMPAT);
  });

  await t.test("a Gemini session drops the thread id Codex minted; nobody else's moves", async () => {
    const gemini = (await providerRow(await newProvider('gemini', 'codex', COMPAT))).slug;
    const openai = (await providerRow(await newProvider('openai', 'codex', 'https://api.openai.com/v1'))).slug;
    const onGemini = await newSession(gemini, 'codex-thread-1');
    const onOpenAI = await newSession(openai, 'codex-thread-2');
    const onClaude = await newSession('claude', randomUUID());

    await sql.query(MIGRATION);

    assert.equal(await runtimeSessionIdOf(onGemini), null);
    assert.equal(await runtimeSessionIdOf(onOpenAI), 'codex-thread-2');
    assert.notEqual(await runtimeSessionIdOf(onClaude), null);
  });

  await t.test("a session on a borrowed Antigravity slug leaves PENDING only through a claim that set the capability", async () => {
    await sql.query(MIGRATION);
    /** PENDING -> RUNNING as a claim writes it, in its own transaction with `settings` applied. */
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
    const capable = `set_config('orbit.runner_supports_antigravity', '1', true)`;
    const slugOf = async (id: string) => (await providerRow(id)).slug;

    const gemini = await slugOf(await newProvider('gemini', 'antigravity', 'https://generativelanguage.googleapis.com'));
    const onGemini = await newSession(gemini, null, 'PENDING');
    // An older control plane sets nothing, and reads the row's runtime as Claude: its claim is
    // dropped. So is one from a runner that never advertised Antigravity.
    assert.equal(await claim(onGemini, ''), 0);
    assert.equal(await claim(onGemini, `set_config('orbit.runner_supports_antigravity', '0', true)`), 0);
    assert.equal((await one<{ status: string }>('SELECT status FROM session WHERE id = $1', [onGemini])).status, 'PENDING');
    // What QueueService.trySessionClaim sets for a runner that advertises `antigravity`.
    assert.equal(await claim(onGemini, capable), 1);

    // A disabled row dispatches as Claude (execRuntime), so nothing about it needs agy; nor does a
    // configured row on any other runtime.
    const disabled = await slugOf(await newProvider('gemini', 'antigravity', 'https://generativelanguage.googleapis.com', false));
    assert.equal(await claim(await newSession(disabled, null, 'PENDING'), ''), 1);
    const deepseek = await slugOf(await newProvider(null, 'claude', 'https://api.deepseek.com/anthropic'));
    assert.equal(await claim(await newSession(deepseek, null, 'PENDING'), ''), 1);
    // And the built-in slug keeps 0367's gate.
    const agy = await newSession('antigravity', null, 'PENDING');
    assert.equal(await claim(agy, ''), 0);
    assert.equal(await claim(agy, capable), 1);
  });
});
