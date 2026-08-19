import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// Unit 02 wrote this file against v1.5, and every assertion in it proved a defect: the specified
// D14 resolver could not run, the declared decision input did not carry what PAC's resolver reads,
// I17 promised a current-state query that a legal interleaving falsifies, the last five seconds of
// a rate-limit window had no legal `nextWakeAt`, and a freshly committed manual trigger matched
// neither shape I18 allowed.
//
// v1.6 closes all five (§24), and an assertion that proves a defect exists must go red the moment
// the defect is fixed. So the file is **flipped, not deleted** — the same discipline §22.9 / §23.5
// applied to the v1.3 and v1.4 adversarial specs. Each test now asserts the *closed* shape, and
// each keeps the v1.5 shape beside it as a **reverse control**: "this really was broken" and "it
// really is closed now" are both stated, in the same test, over the same rows.
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

test('PC-CX-32: the specified D14 resolver is VOLATILE, so it can take the locks it is specified to take', () => {
  const seven = section('7.7');
  const d14 = seven.slice(seven.indexOf('#### D14 '), seven.indexOf('#### D8 '));
  // The closed shape: the resolver is VOLATILE, and the volatility is part of the specification
  // rather than whatever the migration author happened to leave out.
  assert.match(d14, /它是一个 \*\*`VOLATILE`\*\* 的 plpgsql 函数/, 'D14-a must specify a resolver that can take a row lock');
  assert.match(d14, /FOR SHARE/, 'D14 still has to take the locks that make it a gate');
  assert.ok(d14.includes('**D14-f'), 'the volatility has to be argued, not just changed');
  assert.match(d14, /pg_proc\.provolatile/, 'and it has to be asserted where it is observable');

  // Reverse control — the v1.5 shape, kept verbatim: `STABLE` plus `FOR SHARE` is refused by the
  // server, and it may not come back as a live requirement anywhere in the normative body.
  const normative = CONTRACT.slice(0, CONTRACT.indexOf('\n## 19. '));
  const stale = normative.split('\n').map((l) => l.replace(/[`*]/g, ''))
    .filter((l) => l.includes('STABLE 的 SQL 函数') && !/v1\.[1-6]|PC-CX-\d\d/.test(l));
  assert.deepEqual(stale, [], 'the v1.5 sentence that specified an unrunnable object must not be alive');

  // …and the development fixture no longer relies on PostgreSQL's default. That reliance is what
  // made unit 01E's suite green against an object the contract did not specify.
  const fixtureStart = LINEARIZATION.indexOf('CREATE FUNCTION resolve_execution_context_locked');
  const fixtureEnd = LINEARIZATION.indexOf('CREATE CONSTRAINT TRIGGER session_execution_context_guard', fixtureStart);
  assert.ok(fixtureStart >= 0 && fixtureEnd > fixtureStart, 'could not isolate the development PG fixture');
  const fixture = LINEARIZATION.slice(fixtureStart, fixtureEnd);
  assert.equal((fixture.match(/LANGUAGE plpgsql VOLATILE/g) ?? []).length, 2,
    'both locking functions must state their volatility, so the fixture exercises the specified objects');
  assert.ok(LINEARIZATION.includes("test('PC-CX-32 on real Postgres: the D14 objects are VOLATILE, and the deferred trigger really runs'"),
    'and the specified objects have to be built, read from pg_proc, and called on a real server');
});

test('PC-CX-32 on isolated Postgres: VOLATILE plus FOR SHARE runs, and STABLE still cannot',
  { skip: PG_URL ? false : 'set the isolated Coordinator PG identity variables to run' }, async () => {
    const client = await connect();
    try {
      await resetSchema(client);
      await client.query(`
        CREATE TABLE authority (id text PRIMARY KEY, enabled boolean NOT NULL);
        INSERT INTO authority VALUES ('a1', true);
        CREATE FUNCTION resolve_locked() RETURNS boolean
          VOLATILE LANGUAGE plpgsql AS $fn$
        BEGIN
          PERFORM enabled FROM authority WHERE id = 'a1' FOR SHARE;
          RETURN true;
        END;
        $fn$;
      `);

      // The closed shape: the object the contract now specifies runs, and `pg_proc` says why.
      assert.equal((await client.query<{ ok: boolean }>('SELECT resolve_locked() AS ok')).rows[0].ok, true,
        'the specified resolver has to be callable, not merely creatable');
      assert.equal((await client.query<{ provolatile: string }>(
        `SELECT provolatile FROM pg_proc WHERE proname = 'resolve_locked'`)).rows[0].provolatile, 'v',
        'and the reason it runs is a column a migration test can read');

      // Reverse control — the v1.5 object, rebuilt verbatim. Same body, one marker different: the
      // server refuses every call with 0A000, which is the P0 this round closed.
      await client.query(`
        CREATE OR REPLACE FUNCTION resolve_locked() RETURNS boolean
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
        await client.query('SELECT resolve_locked()');
      } catch (error) {
        const pgError = error as Error & { code?: string };
        code = pgError.code;
        message = pgError.message;
      }
      assert.equal(code, '0A000', 'the v1.5 shape must still be reproducible — that is what makes the fix meaningful');
      assert.match(message, /SELECT FOR SHARE is not allowed in a non-volatile function/);
      assert.equal((await client.query<{ provolatile: string }>(
        `SELECT provolatile FROM pg_proc WHERE proname = 'resolve_locked'`)).rows[0].provolatile, 's',
        'and the only difference between the two objects is this one column');
    } finally {
      await client.end();
    }
  });

test('PC-CX-33: the declared decision input carries the inputs PAC\'s resolver reads', () => {
  const world = frozenWorldBlock();
  const team = /"team":\s*\[\s*\{([\s\S]*?)\}\s*\]/.exec(world)?.[1] ?? '';
  const workspaces = /"workspaces":\s*\[\s*\{([\s\S]*?)\}\s*\]/.exec(world)?.[1] ?? '';
  const tasks = /"tasks":\s*\[\s*\{([\s\S]*?)\}\s*\]/.exec(world)?.[1] ?? '';
  const providers = /"providers":\s*\[\s*\{([\s\S]*?)\}\s*\]/.exec(world)?.[1] ?? '';
  assert.ok(team && workspaces && tasks && providers, 'could not isolate the world projections');

  // The closed shape: every column PAC §7.1–§7.4 reads is a field the input declares.
  for (const field of ['defaultProvider', 'defaultModel', 'defaultEffort', 'providerFallbacks', 'projectMemberId', 'requiredCapabilities']) {
    assert.match(team, new RegExp(`"${field}"`), `world.team must carry ${field} — PAC's WHO/WITH chains read it`);
  }
  assert.match(workspaces, /"enabled"/, 'world.workspaces must carry workspace.enabled — PAC §7.3\'s candidate predicate reads it');
  assert.match(tasks, /"workspaceId"/, 'world.tasks must carry the WHERE pin PAC §7.3 priority 1 reads');
  assert.match(providers, /"models"/, 'world.providers must carry the model space EC1 row 5 is defined against');
  assert.match(PAC, /providerFallbacks/, 'PAC still reads the Agent fallback chain');
  assert.match(PAC, /workspace\.enabled = true/, 'PAC still reads workspace.enabled');
  assert.match(section('6.1'), /\*\*S10（PAC 解析链的读集也是 `world` 的一部分/, 'the harvest rule has to be stated, not just the fields');

  // Reverse control — the v1.5 projection, reconstructed field for field. The two hidden states the
  // review published are indistinguishable in it, and PAC requires different runs for each pair.
  const v15Declared = {
    team: [{ agentId: 'a1', role: 'MEMBER', enabled: true, deletedAt: null }],
    tasks: [{ id: 't1', provider: null, model: null, requiredCapabilities: [] }],
    workspaces: [{ workspaceId: 'w1', runnerId: 'r1', deletedAt: null }],
    providers: [{ slug: 'claude', available: true }, { slug: 'codex', available: true }],
  };
  const resolve = (hidden: { defaultProvider: string; defaultModel: string; workspaceEnabled: boolean }): string =>
    `${hidden.defaultProvider}/${hidden.defaultModel}/${hidden.workspaceEnabled ? 'w1' : 'REFUSE'}`;
  const hiddenClaude = { defaultProvider: 'claude', defaultModel: 'claude-opus-5', workspaceEnabled: true };
  const hiddenCodex = { defaultProvider: 'codex', defaultModel: 'gpt-5.6-sol', workspaceEnabled: true };
  assert.equal(JSON.stringify(v15Declared), JSON.stringify(structuredClone(v15Declared)), 'the v1.5 inputs are identical');
  assert.notEqual(resolve(hiddenClaude), resolve(hiddenCodex),
    'the omitted Agent defaults required different provider/model from one declared input — that was the defect');
  assert.notEqual(resolve(hiddenClaude), resolve({ ...hiddenClaude, workspaceEnabled: false }),
    'and the omitted workspace.enabled bit turned DISPATCH into REFUSE without changing the hash');

  // The same pairs, projected the way v1.6 projects them, are no longer identical.
  const v16 = (hidden: { defaultProvider: string; defaultModel: string; workspaceEnabled: boolean }): string =>
    JSON.stringify({
      ...v15Declared,
      team: [{ ...v15Declared.team[0], projectMemberId: 'm1', defaultProvider: hidden.defaultProvider, defaultModel: hidden.defaultModel }],
      workspaces: [{ ...v15Declared.workspaces[0], enabled: hidden.workspaceEnabled }],
    });
  assert.notEqual(v16(hiddenClaude), v16(hiddenCodex));
  assert.notEqual(v16(hiddenClaude), v16({ ...hiddenClaude, workspaceEnabled: false }));
});

test('PC-CX-34: I17 has one tense per sentence, and the current-state query is gone', () => {
  const invariants = section('4.3');
  const fault = section('15');
  // The closed shape: a standing half over columns that stop changing, a point-in-time half that
  // D14 proves at COMMIT, and an explicit account of the state the deleted query used to forbid.
  assert.ok(invariants.includes('**I17-A（快照与占位一致，恒成立'), 'the standing half is missing');
  assert.ok(invariants.includes('**I17-B（授权在提交那一刻成立，点态'), 'the commit-time half is missing');
  assert.ok(invariants.includes('**I17-c（那条被删掉的当前态查询是什么'), 'nothing says what the deleted query described');
  assert.match(fault, /控制环先提交[^\n]+人工写随后生效/, 'F35 still has to allow the coordinator-first ordering');
  assert.match(section('12.1'), /跑一次 I17-A 并断言返回 0 行/, 'the migration must run the invariant that is actually zero-row');

  // Reverse control — the v1.5 reading, replayed. Both facts are still true; what changed is which
  // of them the contract calls an invariant.
  const committed = { liveSession: true, agentEnabledAtSessionCommit: true, agentEnabledNow: false };
  const pointInTime = committed.liveSession && committed.agentEnabledAtSessionCommit;
  const currentStateQuery = committed.liveSession && committed.agentEnabledNow;
  assert.equal(pointInTime, true, 'I17-B: the coordinator-first dispatch was authorised at its commit');
  assert.equal(currentStateQuery, false,
    'and the later legal revocation still makes v1.5\'s current-state query non-zero — it is a legal state, not a violation');

  // I17-A is the one that survives it, because both sides of it are frozen at commit.
  const frozenContext = { agentId: 'a1', provider: 'claude', model: 'claude-opus-5', workspaceId: 'w1', runnerId: 'r1' };
  const sessionSnapshot = { ...frozenContext };
  assert.deepEqual(sessionSnapshot, frozenContext, 'I17-A holds after the revocation, and keeps holding');
  assert.notDeepEqual({ ...sessionSnapshot, provider: 'codex' }, frozenContext, 'and it can still fail, which is what makes it worth running');
});

test('PC-CX-35: the last five seconds of a turn window have exactly one legal wake', () => {
  const windowEndsAt = 60_000;
  const now = 58_000;
  const nextAttemptAt = windowEndsAt;                 // TR2-b ③, unchanged by this round
  const floor = now + 5_000;                          // W3

  // Reverse control — v1.5's three sentences, evaluated over the same instant: `>= now + 5s` and
  // `<= windowEndsAt` have no common solution here. That was the defect.
  const candidates = Array.from({ length: 10_001 }, (_, i) => now + i);
  assert.equal(candidates.some((wake) => wake >= floor && wake <= nextAttemptAt), false,
    'no timestamp satisfies both W3 and v1.5\'s `nextWakeAt <= windowEndsAt`');

  // The closed shape: W5 arbitrates — the floor wins, the bound becomes `windowEndsAt + 5s`, and the
  // wake still fires after the window has expired, so nothing is missed.
  const chosen = Math.max(nextAttemptAt, floor);
  assert.equal(chosen, 63_000);
  assert.ok(chosen >= floor, 'W3 holds');
  assert.ok(chosen <= nextAttemptAt + 5_000, 'I18-C holds');
  assert.ok(chosen >= windowEndsAt, 'and the rate-limit window has expired by the time it fires');

  const turns = section('7.6');
  const timing = section('10.4');
  assert.match(turns, /next_attempt_at`[^\n]+窗口边界/, 'TR2-b still puts next_attempt_at on the boundary');
  assert.match(turns, /nextWakeAt ≤ windowEndsAt \+ 5s/, 'TR2-d must state the bound that has a solution');
  assert.match(timing, /nextWakeAt` \*\*永远不小于 `now \+ 5s`/, 'W3 is unchanged: it is the hard floor');
  assert.match(timing, /\*\*W5（一个候选表、一个确定的选择/, 'the arbitration between the candidates has to be frozen');

  // The second v1.5 conflict: an earlier candidate versus TR2-e's "point at the boundary". W5 takes
  // the minimum and names the winner; TR2-e now says "when it is the chosen candidate".
  const earlierRunAt = 59_000;
  assert.equal(Math.min(earlierRunAt, windowEndsAt), earlierRunAt, '§10.4 still takes the minimum of the applicable wakes');
  assert.match(turns, /当窗口边界是 W5 选中的那个候选时/, 'TR2-e must not demand a reason that contradicts the minimum');
  assert.match(turns, /wakeCandidates/, 'the pending request stays visible through the candidate table');
});

test('PC-CX-36: a manual trigger has a named shape from the moment it is committed', () => {
  const afterEventCommit = {
    event: { kind: 'user.manual_trigger', consumedAt: null as number | null, nextAttemptAt: null as number | null, attempts: 0 },
    runtime: { nextWakeAt: null as number | null },
  };

  // Reverse control — v1.5's two branches, evaluated over the state the user interface commits.
  const i18v15 = afterEventCommit.event.consumedAt !== null ||
    (afterEventCommit.event.nextAttemptAt !== null && afterEventCommit.runtime.nextWakeAt !== null &&
      afterEventCommit.runtime.nextWakeAt <= afterEventCommit.event.nextAttemptAt);
  assert.equal(i18v15, false, 'the normal asynchronous gap matched neither v1.5 shape — that was the defect');

  // The closed shape: three branches, and this state is the first of them.
  const shape = (e: { consumedAt: number | null; nextAttemptAt: number | null; attempts: number }, wake: number | null): string => {
    if (e.consumedAt !== null) return 'A';
    if (e.nextAttemptAt === null && e.attempts === 0) return 'B';
    if (e.nextAttemptAt !== null && wake !== null && wake <= e.nextAttemptAt + 5_000) return 'C';
    return 'NONE';
  };
  assert.equal(shape(afterEventCommit.event, afterEventCommit.runtime.nextWakeAt), 'B', 'awaiting first consumption');
  assert.equal(shape({ consumedAt: null, nextAttemptAt: 60_000, attempts: 0 }, 63_000), 'C', 'rate-limited, wake inside the floor slack');
  assert.equal(shape({ consumedAt: 60_000, nextAttemptAt: null, attempts: 0 }, null), 'A', 'answered');
  assert.equal(shape({ consumedAt: null, nextAttemptAt: null, attempts: 3 }, null), 'NONE', 'attempted and dropped is still a defect');

  const invariants = section('4.3');
  for (const rule of ['**I18-A（已回答', '**I18-B（待首次消费', '**I18-C（已看过、被限频', '**I19（待消费事件的投递不变量']) {
    assert.ok(invariants.includes(rule), `§4.3 does not state ${rule}）`);
  }
  // The producer still owes nothing to `project_runtime` — the delivery obligation is a backstop
  // branch instead, and that trade is argued rather than assumed.
  assert.doesNotMatch(section('5.4'), /manual_trigger[^\n]+next_wake_at/,
    'the event producer must not have quietly gained an atomic runtime-wake obligation');
  assert.match(section('10.2'), /\(iv\) 队列里躺着一条没人看的事件/, 'the backstop must own the gap the producer does not');
  assert.match(invariants, /\*\*I18-note（为什么事件生产者不原子写 runtime wake/, 'and the choice between the two has to be argued');
});
