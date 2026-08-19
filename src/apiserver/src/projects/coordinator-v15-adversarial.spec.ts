import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

const REPO = path.resolve(__dirname, '../../../..');
const CONTRACT = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
const PAC = readFileSync(path.join(REPO, 'docs/project-agent-contract.md'), 'utf8');
const LINEARIZATION = readFileSync(
  path.join(REPO, 'src/apiserver/src/projects/coordinator-linearization.pg.spec.ts'),
  'utf8',
);
const PG_URL = process.env.COORDINATOR_PG_URL;
const REVIEW_SCHEMA = 'pcc_v15_rereview';

function section(number: string): string {
  const escaped = number.replace('.', '\\.');
  const start = new RegExp(`^##(?:#)?\\s+${escaped}(?:\\s|\\.)`, 'm').exec(CONTRACT);
  assert.ok(start, `section ${number} is missing`);
  const level = CONTRACT.slice(start.index).match(/^#+/)?.[0].length ?? 2;
  const rest = CONTRACT.slice(start.index + start[0].length);
  const end = new RegExp(`^#{1,${level}}\\s+\\d`, 'm').exec(rest);
  return CONTRACT.slice(start.index, end ? start.index + start[0].length + end.index : undefined);
}

function frozenWorldBlock(): string {
  const input = section('6.1');
  const start = input.indexOf('  "world": {');
  const end = input.indexOf('\n  },\n\n  "evaluation":', start);
  assert.ok(start >= 0 && end > start, 'could not isolate the frozen world projection');
  return input.slice(start, end);
}

type ClientCtor = new (config: { connectionString?: string }) => Client;

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: PG_URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

async function resetSchema(client: Client): Promise<void> {
  await client.query(`DROP SCHEMA IF EXISTS ${REVIEW_SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${REVIEW_SCHEMA}`);
  await client.query(`SET search_path TO ${REVIEW_SCHEMA}`);
}

test('PC-CX-32: the specified STABLE D14 resolver cannot take FOR SHARE', () => {
  const d14 = section('7.7').slice(section('7.7').indexOf('#### D14 '), section('7.7').indexOf('#### D8 '));
  assert.match(d14, /`STABLE`/, 'D14-a no longer specifies a STABLE resolver');
  assert.match(d14, /FOR SHARE/, 'D14-a no longer specifies the locking read');

  const fixtureStart = LINEARIZATION.indexOf('CREATE FUNCTION resolve_execution_context_locked');
  const fixtureEnd = LINEARIZATION.indexOf('CREATE FUNCTION session_execution_context_guard', fixtureStart);
  const fixture = LINEARIZATION.slice(fixtureStart, fixtureEnd);
  assert.ok(fixtureStart >= 0 && fixtureEnd > fixtureStart, 'could not isolate the development PG fixture');
  assert.doesNotMatch(fixture, /\bSTABLE\b/,
    'the green development fixture is VOLATILE by default, so it does not exercise the specified function volatility');
});

test('PC-CX-32 on isolated Postgres: STABLE plus FOR SHARE fails before the guard can decide',
  { skip: PG_URL ? false : 'set the isolated Coordinator PG identity variables to run' }, async () => {
    const client = await connect();
    try {
      await resetSchema(client);
      await client.query(`
        CREATE TABLE authority (id text PRIMARY KEY, enabled boolean NOT NULL);
        INSERT INTO authority VALUES ('a1', true);
        CREATE FUNCTION resolve_locked_stable() RETURNS boolean
          STABLE LANGUAGE plpgsql AS $fn$
        BEGIN
          PERFORM enabled FROM authority WHERE id = 'a1' FOR SHARE;
          RETURN true;
        END;
        $fn$;
      `);

      let code: string | undefined;
      let message = '';
      try {
        await client.query('SELECT resolve_locked_stable()');
      } catch (error) {
        const pgError = error as Error & { code?: string };
        code = pgError.code;
        message = pgError.message;
      }
      assert.equal(code, '0A000');
      assert.match(message, /SELECT FOR SHARE is not allowed in a non-volatile function/);

      const volatility = (await client.query<{ provolatile: string }>(
        `SELECT provolatile FROM pg_proc WHERE proname = 'resolve_locked_stable'`,
      )).rows[0].provolatile;
      assert.equal(volatility, 's', 'the failure is the specified STABLE volatility, not a fixture accident');

      await client.query(`
        CREATE OR REPLACE FUNCTION resolve_locked_stable() RETURNS boolean
          VOLATILE LANGUAGE plpgsql AS $fn$
        BEGIN
          PERFORM enabled FROM authority WHERE id = 'a1' FOR SHARE;
          RETURN true;
        END;
        $fn$;
      `);
      assert.equal((await client.query<{ ok: boolean }>('SELECT resolve_locked_stable() AS ok')).rows[0].ok, true,
        'the same locking read runs once the contradictory volatility promise is removed');
    } finally {
      await client.end();
    }
  });

test('PC-CX-33: the declared decision input omits PAC execution-context inputs', () => {
  const world = frozenWorldBlock();
  const team = /"team":\s*\[\s*\{([^}]+)\}/.exec(world)?.[1] ?? '';
  const workspaces = /"workspaces":\s*\[\s*\{([\s\S]*?)\}\s*\]/.exec(world)?.[1] ?? '';
  assert.ok(team && workspaces, 'could not isolate team/workspace projections');

  for (const field of ['defaultProvider', 'defaultModel', 'defaultEffort', 'providerFallbacks', 'projectMemberId']) {
    assert.doesNotMatch(team, new RegExp(field), `world.team unexpectedly carries ${field}`);
  }
  assert.doesNotMatch(workspaces, /"enabled"/, 'world.workspaces unexpectedly carries workspace.enabled');
  assert.match(PAC, /providerFallbacks/, 'PAC no longer reads the Agent fallback chain');
  assert.match(PAC, /workspace\.enabled = true/, 'PAC no longer reads workspace.enabled');

  const declared = {
    team: [{ agentId: 'a1', role: 'MEMBER', enabled: true, deletedAt: null }],
    tasks: [{ id: 't1', provider: null, model: null, requiredCapabilities: [] }],
    workspaces: [{ workspaceId: 'w1', runnerId: 'r1', deletedAt: null }],
    providers: [{ slug: 'claude', available: true }, { slug: 'codex', available: true }],
  };
  const hiddenClaude = { defaultProvider: 'claude', defaultModel: 'claude-opus-5', workspaceEnabled: true };
  const hiddenCodex = { defaultProvider: 'codex', defaultModel: 'gpt-5.6-sol', workspaceEnabled: true };
  const resolve = (hidden: typeof hiddenClaude): string =>
    `${hidden.defaultProvider}/${hidden.defaultModel}/${hidden.workspaceEnabled ? 'w1' : 'REFUSE'}`;

  assert.equal(JSON.stringify(declared), JSON.stringify(structuredClone(declared)), 'the declared inputs are identical');
  assert.notEqual(resolve(hiddenClaude), resolve(hiddenCodex),
    'the omitted Agent defaults require different provider/model and execution-context digests from one declared input');

  const disabledWorkspace = { ...hiddenClaude, workspaceEnabled: false };
  assert.notEqual(resolve(hiddenClaude), resolve(disabledWorkspace),
    'the omitted workspace.enabled bit changes DISPATCH into REFUSE without changing decisionInputHash');
});

test('PC-CX-34: I17 is both a commit-time predicate and an impossible current-state invariant', () => {
  const invariants = section('4.3');
  const fault = section('15');
  assert.match(invariants, /任何\*\*已提交\*\*的 COORDINATOR 占位 Session/);
  assert.match(invariants, /不存在[^\n]+enabled = false/,
    'I17 no longer claims the current-state zero-row query');
  assert.match(fault, /控制环先提交[^\n]+人工写随后生效/,
    'F35 no longer allows the coordinator-first ordering');

  const committed = { liveSession: true, agentEnabledAtSessionCommit: true, agentEnabledNow: false };
  const pointInTime = committed.liveSession && committed.agentEnabledAtSessionCommit;
  const currentStateQuery = committed.liveSession && committed.agentEnabledNow;
  assert.equal(pointInTime, true, 'the coordinator-first dispatch was authorised at its commit');
  assert.equal(currentStateQuery, false,
    'the later legal revocation makes the contract\'s supposedly equivalent current-state query return a violation');
});

test('PC-CX-34 on isolated Postgres: the commit guard permits the current state that I17 forbids',
  { skip: PG_URL ? false : 'set the isolated Coordinator PG identity variables to run' }, async () => {
    const client = await connect();
    try {
      await resetSchema(client);
      await client.query(`
        CREATE TABLE agent (id text PRIMARY KEY, enabled boolean NOT NULL);
        CREATE TABLE session (id text PRIMARY KEY, agent_id text NOT NULL REFERENCES agent(id), status text NOT NULL);
        CREATE FUNCTION guard_at_session_commit() RETURNS trigger
          VOLATILE LANGUAGE plpgsql AS $fn$
        DECLARE allowed boolean;
        BEGIN
          SELECT enabled INTO allowed FROM agent WHERE id = NEW.agent_id FOR SHARE;
          IF NOT allowed THEN RAISE EXCEPTION 'EXECUTION_CONTEXT_REVOKED: AGENT'; END IF;
          RETURN NULL;
        END;
        $fn$;
        CREATE CONSTRAINT TRIGGER guard_at_session_commit
          AFTER INSERT ON session DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION guard_at_session_commit();
        INSERT INTO agent VALUES ('a1', true);
      `);

      await client.query(`INSERT INTO session VALUES ('s1', 'a1', 'RUNNING')`);
      await client.query(`UPDATE agent SET enabled = false WHERE id = 'a1'`);
      const violations = Number((await client.query<{ n: string }>(`
        SELECT count(*)::text AS n
          FROM session s JOIN agent a ON a.id = s.agent_id
         WHERE s.status IN ('PENDING','RUNNING') AND NOT a.enabled
      `)).rows[0].n);
      assert.equal(violations, 1,
        'the coordinator-first order commits, the later revocation succeeds, and I17\'s current-state query is nonzero');
    } finally {
      await client.end();
    }
  });

test('PC-CX-35: the last five seconds of a turn window cannot satisfy both W3 and I18', () => {
  const windowEndsAt = 60_000;
  const now = 58_000;
  const nextAttemptAt = windowEndsAt;       // TR2-b
  const earliestWakeAllowedByW3 = now + 5_000;
  assert.ok(earliestWakeAllowedByW3 > nextAttemptAt);
  const candidates = Array.from({ length: 10_001 }, (_, i) => now + i);
  assert.equal(candidates.some((wake) => wake >= earliestWakeAllowedByW3 && wake <= nextAttemptAt), false,
    'no nextWakeAt can be both >= now+5s (W3) and <= the window boundary (I18/TR2-d)');

  const turns = section('7.6');
  const timing = section('10.4');
  assert.match(turns, /next_attempt_at`[^\n]+窗口边界/);
  assert.match(turns, /nextWakeAt` 必然 `≤ windowEndsAt`/);
  assert.match(timing, /nextWakeAt` \*\*永远不小于 `now \+ 5s`/);

  const earlierRunAt = 59_000;
  assert.equal(Math.min(earlierRunAt, windowEndsAt), earlierRunAt,
    '§10.4 chooses another applicable wake before the turn window');
  assert.match(turns, /next_wake_at` 指向同一时刻且 `next_wake_reason = 'manual trigger rate-limited'/,
    'TR2-e no longer requires an exact time/reason that conflicts with the minimum-of-all-wakes rule');
});

test('PC-CX-36: a newly committed manual trigger violates I18 before reconcile runs', () => {
  const afterEventCommit = {
    event: { kind: 'user.manual_trigger', consumedAt: null, nextAttemptAt: null },
    runtime: { nextWakeAt: null },
  };
  const i18 = afterEventCommit.event.consumedAt !== null ||
    (afterEventCommit.event.nextAttemptAt !== null && afterEventCommit.runtime.nextWakeAt !== null &&
      afterEventCommit.runtime.nextWakeAt <= afterEventCommit.event.nextAttemptAt);
  assert.equal(i18, false,
    'event insertion and asynchronous reconcile leave a committed state outside I18\'s two allowed shapes');

  assert.match(section('4.3'), /任何已提交状态上，每一条 `kind = 'user\.manual_trigger'/,
    'I18 no longer claims to cover every committed state');
  assert.doesNotMatch(section('5.4'), /manual_trigger[^\n]+next_wake_at/,
    'the event producer unexpectedly gained the atomic runtime-wake obligation needed to make I18 true');
});
