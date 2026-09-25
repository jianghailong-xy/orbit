/**
 * 0307's data model, the nine Orbit Wiki tables, against a real PostgreSQL.
 *
 * contracts/wiki.contract.json is read here, not copied. Every closed set is held to the CHECK that
 * keeps it both ways: each value the contract lists is stored, a value outside it is refused by the
 * constraint named for it, and that constraint lists exactly the contract's values. The length
 * limits are the contract's numbers. On top of that, each of the four things the task that froze the
 * contract asks of the schema is its own case: the nine tables exist; a CHECK refuses a value outside
 * a closed set; a row under a space, or under a row under a space, whose owner is not its parent's
 * is refused by the composite foreign key; and (entry_id, revision) is unique.
 *
 * The rest witnesses what the migration's header claims: each invariant the contract states refuses
 * the row that breaks it; the ids that point at Orbit's history carry no foreign key (in the catalog,
 * and by deleting what they name); deleting an owner deletes every wiki row through both paths into
 * an op; and the keyword-search index answers the function it is built on and nothing spelled
 * otherwise. Every assertion is on behaviour — a row written and refused or kept — except the three
 * that are about the catalog itself: the table list, the foreign-key list and the plan.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki/wiki-schema.pg.spec.ts
 *
 * Non-destructive: it writes only rows carrying its own uuid prefix, and deletes them afterwards.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const CONTRACT: any = JSON.parse(
  readFileSync(path.resolve(__dirname, '../../../../contracts/wiki.contract.json'), 'utf8'),
);
const LIMITS: Record<string, number> = CONTRACT.limits;
const TABLES: string[] = CONTRACT.storage.tables;

/** Fixture ids all carry this prefix; cleanup goes by it, never by emptying a table. */
const FIX = '03070307-0307-4307-8307-';
const id = (n: number) => `${FIX}${String(n).padStart(12, '0')}`;

const OWNER = id(1);
const OTHER = id(2);
/** The owner the deletion case deletes. */
const GONE = id(3);
const WS = id(11);
const WS_OTHER = id(12);
const WS_GONE = id(13);
const SPACE = id(21);
const SPACE_OTHER = id(22);
const SPACE_GONE = id(23);
const ENTRY = id(31);
const ENTRY_OTHER = id(32);
const REVISION = id(41);
const REVISION_OTHER = id(42);
const CHANGESET = id(51);
const SESSION = id(201);
const TOOL_CALL = id(202);
/** The row each positive control writes and rolls back, and each refused write tries to write. */
const PROBE = id(39);

type Row = Record<string, unknown>;

const DAY = 86_400_000;

const spaceRow = (over: Row = {}): Row => ({ id: SPACE, owner_id: OWNER, slug: 'orbit', title: 'Orbit', ...over });
const bindingRow = (over: Row = {}): Row => ({ id: id(101), space_id: SPACE, owner_id: OWNER, workspace_id: WS, ...over });
const topicRow = (over: Row = {}): Row => ({ id: id(91), space_id: SPACE, owner_id: OWNER, slug: 'testing', title: 'Testing', ...over });
const entryRow = (over: Row = {}): Row => ({
  id: ENTRY,
  owner_id: OWNER,
  space_id: SPACE,
  kind: 'pitfall',
  status: 'active',
  trust: 'owner',
  current_revision: 1,
  title: 'A pg spec with no database skips',
  summary: 'node --test exits 0 on a pg spec whose every case skipped.',
  fields: JSON.stringify({ fix: 'Run it through scripts/run-pg-spec.sh.' }),
  ...over,
});
const revisionRow = (over: Row = {}): Row => ({
  id: REVISION,
  entry_id: ENTRY,
  owner_id: OWNER,
  revision: 1,
  title: 'A pg spec with no database skips',
  summary: 'node --test exits 0 on a pg spec whose every case skipped.',
  fields: '{}',
  content_sha256: 'a'.repeat(64),
  author_kind: 'agent',
  ...over,
});
const sourceRow = (over: Row = {}): Row => ({
  id: id(71), revision_id: REVISION, owner_id: OWNER, kind: 'turn', ref: SESSION, ...over,
});
const changesetRow = (over: Row = {}): Row => ({
  id: CHANGESET,
  owner_id: OWNER,
  space_id: SPACE,
  origin: 'agent',
  status: 'pending',
  expires_at: new Date(Date.now() + LIMITS.pendingExpiryDays * DAY),
  ...over,
});
const opRow = (over: Row = {}): Row => ({
  id: id(61), changeset_id: CHANGESET, owner_id: OWNER, seq: 0, op: 'add', payload: '{}', ...over,
});
const exposureRow = (over: Row = {}): Row => ({
  id: id(81), owner_id: OWNER, entry_id: ENTRY, revision: 1, session_id: SESSION, channel: 'push', ...over,
});

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const client = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

function insert(client: Client, table: string, row: Row) {
  const cols = Object.keys(row);
  return client.query(
    `INSERT INTO "${table}"(${cols.map((c) => `"${c}"`).join(',')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`,
    Object.values(row),
  );
}

/** Assert the write is refused, and that the refusal names the constraint meant. */
async function refuses(run: () => Promise<unknown>, constraint: string, why: string): Promise<void> {
  const error = await run().then(() => null, (e: Error) => e);
  assert.ok(error, `${why} — this write should have been refused by ${constraint}, but it succeeded`);
  assert.match(error.message, new RegExp(`"${constraint}"`), `${why} — refused, but not by ${constraint}`);
}

/** A write that must succeed, rolled back afterwards: the positive control a refusal is read against. */
async function admits(client: Client, run: () => Promise<unknown>): Promise<void> {
  await client.query('BEGIN');
  try {
    await run();
  } finally {
    await client.query('ROLLBACK');
  }
}

async function cleanup(client: Client): Promise<void> {
  // A space's delete reaches everything under it, but each table is named so a failure path that
  // built half a fixture is emptied too. Entries go in one statement: they point at each other.
  for (const table of [
    'wiki_exposure', 'wiki_source', 'wiki_changeset_op', 'wiki_entry_revision', 'wiki_changeset',
    'wiki_space_workspace', 'wiki_topic', 'wiki_entry', 'wiki_space',
    'tool_call', 'session', 'workspace', 'user',
  ]) {
    await client.query(`DELETE FROM "${table}" WHERE "id"::text LIKE $1`, [`${FIX}%`]);
  }
}

async function seed(client: Client): Promise<void> {
  await cleanup(client);
  // Raw-SQL fixtures supply `updated_at` on `session` themselves: Prisma's `@updatedAt` is
  // client-side there. The wiki tables' own defaults are the database's.
  await client.query(
    `INSERT INTO "user"("id","email","name","password_hash")
     VALUES ($1,$2,'wiki owner','h'), ($3,$4,'another owner','h'), ($5,$6,'a leaving owner','h')`,
    [OWNER, `${FIX}a@wiki.invalid`, OTHER, `${FIX}b@wiki.invalid`, GONE, `${FIX}c@wiki.invalid`],
  );
  await client.query(
    `INSERT INTO "workspace"("id","name","owner_id") VALUES ($1,'orbit',$2), ($3,'theirs',$4), ($5,'leaving',$6)`,
    [WS, OWNER, WS_OTHER, OTHER, WS_GONE, GONE],
  );
  await client.query(
    `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","updated_at")
     VALUES ($1,'the session a proposal came from','p',$2,$2,now())`,
    [SESSION, OWNER],
  );
  await client.query(`INSERT INTO "tool_call"("id","session_id","name") VALUES ($1,$2,'mcp__orbit__wiki_propose')`, [
    TOOL_CALL,
    SESSION,
  ]);
  // Both owners take the slug `orbit` and the same repository: each is unique per owner, not globally.
  await insert(client, 'wiki_space', spaceRow({ repo_url_norm: 'github.com/wiki-spec/orbit' }));
  await insert(client, 'wiki_space', spaceRow({ id: SPACE_OTHER, owner_id: OTHER, repo_url_norm: 'github.com/wiki-spec/orbit' }));
  await insert(client, 'wiki_entry', entryRow());
  await insert(client, 'wiki_entry', entryRow({ id: ENTRY_OTHER, owner_id: OTHER, space_id: SPACE_OTHER }));
  await insert(client, 'wiki_entry_revision', revisionRow());
  await insert(client, 'wiki_entry_revision', revisionRow({ id: REVISION_OTHER, entry_id: ENTRY_OTHER, owner_id: OTHER }));
  await insert(client, 'wiki_changeset', changesetRow());
}

/** The values a CHECK spells out, in the order it spells them. */
async function checkValues(client: Client, table: string, constraint: string): Promise<string[]> {
  const def = await client.query<{ def: string }>(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass`,
    [constraint, table],
  );
  assert.equal(def.rowCount, 1, `${table} has no constraint ${constraint}`);
  return [...def.rows[0].def.matchAll(/'([^']+)'::text/gu)].map((m) => m[1]);
}

/** Every wiki row an owner has, across the nine tables. */
async function rowsOf(client: Client, owner: string): Promise<number> {
  const counts = TABLES.map((table) => `(SELECT count(*) FROM "${table}" WHERE "owner_id" = $1)`).join(' + ');
  const result = await client.query<{ n: number }>(`SELECT (${counts})::int AS n`, [owner]);
  return result.rows[0].n;
}

test('0307 · the Orbit Wiki data model', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const client = await connect();
  t.after(async () => {
    await cleanup(client).catch(() => undefined);
    await client.end().catch(() => undefined);
  });

  await t.test('the nine tables exist, and each carries its own owner', async () => {
    assert.deepEqual(TABLES, [
      'wiki_space',
      'wiki_space_workspace',
      'wiki_topic',
      'wiki_entry',
      'wiki_entry_revision',
      'wiki_source',
      'wiki_changeset',
      'wiki_changeset_op',
      'wiki_exposure',
    ]);
    const found = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = ANY($1)`,
      [TABLES],
    );
    assert.deepEqual(found.rows.map((r) => r.table_name).sort(), [...TABLES].sort());
    const owned = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND column_name = 'owner_id' AND is_nullable = 'NO'
          AND data_type = 'uuid' AND table_name = ANY($1)`,
      [TABLES],
    );
    assert.deepEqual(owned.rows.map((r) => r.table_name).sort(), [...TABLES].sort(),
      'a wiki table without a non-null owner_id cannot be read or deleted by owner');
  });

  // ── closed sets: each one's CHECK admits the contract's values, refuses anything else, and lists
  //    exactly the contract's values ──────────────────────────────────────────────────────────────

  await t.test('every closed set is a CHECK that admits exactly the contract\'s values', async () => {
    await seed(client);
    const terminal = ['superseded', 'retired', 'rejected'];
    const casBound = ['amend', 'supersede', 'retire'];
    const sets: Array<{ table: string; column: string; constraint: string; values: string[]; write: (v: string) => Promise<unknown> }> = [
      {
        table: 'wiki_entry', column: 'kind', constraint: 'wiki_entry_kind_chk',
        values: Object.keys(CONTRACT.kinds),
        write: (kind) => insert(client, 'wiki_entry', entryRow({ id: PROBE, kind })),
      },
      {
        table: 'wiki_entry', column: 'status', constraint: 'wiki_entry_status_chk',
        values: CONTRACT.states.entry.values,
        // Each status in the shape the other invariants ask of it, so only the status is on trial.
        write: (status) => insert(client, 'wiki_entry', entryRow({
          id: PROBE,
          status,
          trust: status === 'proposed' || status === 'rejected' ? 'proposed' : 'confirmed',
          retired_at: terminal.includes(status) ? new Date() : null,
          superseded_by_id: status === 'superseded' ? ENTRY : null,
        })),
      },
      {
        table: 'wiki_entry', column: 'trust', constraint: 'wiki_entry_trust_chk',
        values: CONTRACT.trust.values,
        write: (trust) => insert(client, 'wiki_entry', entryRow({ id: PROBE, trust, status: trust === 'proposed' ? 'proposed' : 'active' })),
      },
      {
        table: 'wiki_entry', column: 'anchor_state', constraint: 'wiki_entry_anchor_state_chk',
        values: Object.keys(CONTRACT.anchorStates),
        write: (state) => insert(client, 'wiki_entry', entryRow({ id: PROBE, anchor_state: state })),
      },
      {
        table: 'wiki_entry_revision', column: 'author_kind', constraint: 'wiki_entry_revision_author_kind_chk',
        values: Object.keys(CONTRACT.authorKinds),
        write: (kind) => insert(client, 'wiki_entry_revision', revisionRow({
          id: PROBE, revision: 2, author_kind: kind, author_user_id: kind === 'owner' ? OWNER : null,
        })),
      },
      {
        table: 'wiki_source', column: 'kind', constraint: 'wiki_source_kind_chk',
        values: Object.keys(CONTRACT.sourceKinds),
        write: (kind) => insert(client, 'wiki_source', sourceRow({ id: PROBE, kind, tainted: kind === 'url' })),
      },
      {
        table: 'wiki_source', column: 'state', constraint: 'wiki_source_state_chk',
        values: CONTRACT.sourceStates.values,
        write: (state) => insert(client, 'wiki_source', sourceRow({ id: PROBE, state })),
      },
      {
        table: 'wiki_changeset', column: 'origin', constraint: 'wiki_changeset_origin_chk',
        values: Object.keys(CONTRACT.changesetOrigins),
        write: (origin) => insert(client, 'wiki_changeset', changesetRow({ id: PROBE, origin })),
      },
      {
        table: 'wiki_changeset', column: 'status', constraint: 'wiki_changeset_status_chk',
        values: CONTRACT.states.changeset.values,
        write: (status) => insert(client, 'wiki_changeset', changesetRow({
          id: PROBE, status, decided_at: status === 'settled' ? new Date() : null,
        })),
      },
      {
        table: 'wiki_changeset_op', column: 'op', constraint: 'wiki_changeset_op_op_chk',
        values: Object.keys(CONTRACT.ops),
        write: (op) => insert(client, 'wiki_changeset_op', opRow({
          id: PROBE, op, entry_id: op === 'add' ? null : ENTRY, base_revision: casBound.includes(op) ? 1 : null,
        })),
      },
      {
        table: 'wiki_changeset_op', column: 'decision', constraint: 'wiki_changeset_op_decision_chk',
        values: CONTRACT.states.op.values,
        write: (decision) => insert(client, 'wiki_changeset_op', opRow({
          id: PROBE,
          decision,
          decided_at: decision === 'pending' ? null : new Date(),
          decision_reason: decision === 'rejected' ? 'duplicate' : null,
        })),
      },
      {
        table: 'wiki_changeset_op', column: 'decision_reason', constraint: 'wiki_changeset_op_decision_reason_chk',
        values: Object.keys(CONTRACT.rejectReasons),
        write: (reason) => insert(client, 'wiki_changeset_op', opRow({
          id: PROBE, decision: 'rejected', decided_at: new Date(), decision_reason: reason,
        })),
      },
      {
        table: 'wiki_exposure', column: 'channel', constraint: 'wiki_exposure_channel_chk',
        values: Object.keys(CONTRACT.exposureChannels),
        write: (channel) => insert(client, 'wiki_exposure', exposureRow({ id: PROBE, channel })),
      },
    ];
    for (const set of sets) {
      const label = `${set.table}.${set.column}`;
      for (const value of set.values) await admits(client, () => set.write(value));
      await refuses(() => set.write('bogus'), set.constraint, `${label} is a closed set`);
      assert.deepEqual((await checkValues(client, set.table, set.constraint)).sort(), [...set.values].sort(),
        `${set.constraint} lists other values than the contract's ${label}`);
    }
    // The assumption kind is phase 3's: storage admits the word now so that phase needs no migration.
    assert.ok(Object.keys(CONTRACT.kinds).includes('assumption'));
  });

  await t.test('every anchor\'s type is one of the contract\'s anchor types, on an entry and on a revision', async () => {
    await seed(client);
    const types = Object.keys(CONTRACT.anchorTypes);
    for (const type of types) {
      await admits(client, () => insert(client, 'wiki_entry', entryRow({ id: PROBE, anchors: JSON.stringify([{ type }]) })));
    }
    await admits(client, () => insert(client, 'wiki_entry', entryRow({
      id: PROBE, anchors: JSON.stringify(types.map((type) => ({ type, checked: 'the server keeps its last check beside it' }))),
    })));
    // An unknown type, no type, a type that is not a string, something that is not an object, an
    // anchor nested one array too deep, and anchors that are not a list at all.
    for (const anchors of [[{ type: 'file' }], [{ path: 'docs/wiki-design.md' }], [{ type: 5 }], [{ type: ['path'] }],
      ['path'], [[{ type: 'path' }]], [{ type: 'path' }, { type: 'bogus' }], { type: 'path' }]) {
      await refuses(() => insert(client, 'wiki_entry', entryRow({ id: PROBE, anchors: JSON.stringify(anchors) })),
        'wiki_entry_anchors_chk', `anchors ${JSON.stringify(anchors)}`);
    }
    await refuses(
      () => insert(client, 'wiki_entry_revision', revisionRow({ id: PROBE, revision: 2, anchors: JSON.stringify([{ type: 'file' }]) })),
      'wiki_entry_revision_anchors_chk', 'a revision holds its anchors to the same types');
    const fn = await client.query<{ def: string }>(`SELECT pg_get_functiondef('wiki_anchors_valid'::regproc) AS def`);
    const listed = [...fn.rows[0].def.matchAll(/@\.type == "([a-z_]+)"/gu)].map((m) => m[1]);
    assert.deepEqual(listed.sort(), [...types].sort(), 'wiki_anchors_valid lists other types than the contract');
  });

  // ── the contract's limits are the database's too ─────────────────────────────────────────────

  await t.test('the contract\'s length limits hold in the database', async () => {
    await seed(client);
    const chars = (n: number) => 'x'.repeat(n);
    const list = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word}-${i}`);
    const cases: Array<[string, (n: number) => Promise<unknown>, number, string]> = [
      ['an entry title', (n) => insert(client, 'wiki_entry', entryRow({ id: PROBE, title: chars(n) })), LIMITS.titleMaxChars, 'wiki_entry_title_chk'],
      ['an entry summary', (n) => insert(client, 'wiki_entry', entryRow({ id: PROBE, summary: chars(n) })), LIMITS.summaryMaxChars, 'wiki_entry_summary_chk'],
      ['an entry\'s topics', (n) => insert(client, 'wiki_entry', entryRow({ id: PROBE, topics: list(n, 'topic') })), LIMITS.topicsMax, 'wiki_entry_topics_chk'],
      ['an entry\'s aliases', (n) => insert(client, 'wiki_entry', entryRow({ id: PROBE, aliases: list(n, 'alias') })), LIMITS.aliasesMax, 'wiki_entry_aliases_chk'],
      ['a revision title', (n) => insert(client, 'wiki_entry_revision', revisionRow({ id: PROBE, revision: 2, title: chars(n) })), LIMITS.titleMaxChars, 'wiki_entry_revision_title_chk'],
      ['a revision summary', (n) => insert(client, 'wiki_entry_revision', revisionRow({ id: PROBE, revision: 2, summary: chars(n) })), LIMITS.summaryMaxChars, 'wiki_entry_revision_summary_chk'],
      ['a revision\'s topics', (n) => insert(client, 'wiki_entry_revision', revisionRow({ id: PROBE, revision: 2, topics: list(n, 'topic') })), LIMITS.topicsMax, 'wiki_entry_revision_topics_chk'],
      ['a revision\'s aliases', (n) => insert(client, 'wiki_entry_revision', revisionRow({ id: PROBE, revision: 2, aliases: list(n, 'alias') })), LIMITS.aliasesMax, 'wiki_entry_revision_aliases_chk'],
      ['a quote', (n) => insert(client, 'wiki_source', sourceRow({ id: PROBE, quote: chars(n), quote_sha256: 'b'.repeat(64) })), LIMITS.quoteMaxChars, 'wiki_source_quote_chk'],
      ['a space slug', (n) => insert(client, 'wiki_space', spaceRow({ id: PROBE, slug: chars(n) })), LIMITS.slugMaxChars, 'wiki_space_slug_chk'],
    ];
    for (const [name, write, limit, constraint] of cases) {
      await admits(client, () => write(limit));
      await refuses(() => write(limit + 1), constraint, `${name} one past the contract's limit of ${limit}`);
    }
    // Characters, not bytes: 120 Chinese characters are 360 bytes and still a title.
    await admits(client, () => insert(client, 'wiki_entry', entryRow({ id: PROBE, title: '迁'.repeat(LIMITS.titleMaxChars) })));
    // And blank is not short: a title of spaces says nothing.
    await refuses(() => insert(client, 'wiki_entry', entryRow({ id: PROBE, title: '   ' })), 'wiki_entry_title_chk', 'a blank title');
  });

  // ── the headline: a row under a space cannot belong to another owner ─────────────────────────

  await t.test('a row under a space cannot belong to another owner than its parent', async () => {
    await seed(client);
    const cases: Array<[string, () => Promise<unknown>, string]> = [
      ['a binding of another owner',
        () => insert(client, 'wiki_space_workspace', bindingRow({ id: PROBE, owner_id: OTHER, workspace_id: WS_OTHER })),
        'wiki_space_workspace_space_fkey'],
      ['a binding to another owner\'s workspace',
        () => insert(client, 'wiki_space_workspace', bindingRow({ id: PROBE, workspace_id: WS_OTHER })),
        'wiki_space_workspace_workspace_fkey'],
      ['a topic', () => insert(client, 'wiki_topic', topicRow({ id: PROBE, owner_id: OTHER })), 'wiki_topic_space_fkey'],
      ['an entry', () => insert(client, 'wiki_entry', entryRow({ id: PROBE, owner_id: OTHER })), 'wiki_entry_space_fkey'],
      ['a changeset', () => insert(client, 'wiki_changeset', changesetRow({ id: PROBE, owner_id: OTHER })), 'wiki_changeset_space_fkey'],
      ['a revision', () => insert(client, 'wiki_entry_revision', revisionRow({ id: PROBE, owner_id: OTHER, revision: 2 })),
        'wiki_entry_revision_entry_fkey'],
      ['a source', () => insert(client, 'wiki_source', sourceRow({ id: PROBE, owner_id: OTHER })), 'wiki_source_revision_fkey'],
      ['an op', () => insert(client, 'wiki_changeset_op', opRow({ id: PROBE, owner_id: OTHER })), 'wiki_changeset_op_changeset_fkey'],
      ['an op about another owner\'s entry',
        () => insert(client, 'wiki_changeset_op', opRow({ id: PROBE, op: 'challenge', entry_id: ENTRY_OTHER })),
        'wiki_changeset_op_entry_fkey'],
      ['an op that resulted in another owner\'s entry',
        () => insert(client, 'wiki_changeset_op', opRow({ id: PROBE, result_entry_id: ENTRY_OTHER })),
        'wiki_changeset_op_result_entry_fkey'],
      ['an exposure', () => insert(client, 'wiki_exposure', exposureRow({ id: PROBE, owner_id: OTHER })), 'wiki_exposure_entry_fkey'],
      ['a supersession of another owner\'s entry',
        () => insert(client, 'wiki_entry', entryRow({ id: PROBE, supersedes_id: ENTRY_OTHER })),
        'wiki_entry_supersedes_fkey'],
      ['a successor that is another owner\'s entry',
        () => insert(client, 'wiki_entry', entryRow({
          id: PROBE, status: 'superseded', trust: 'confirmed', retired_at: new Date(), superseded_by_id: ENTRY_OTHER,
        })),
        'wiki_entry_superseded_by_fkey'],
    ];
    for (const [name, write, constraint] of cases) {
      await refuses(write, constraint, `${name} crossed owners`);
    }
    // The same rows, each under its own owner: what the keys refuse is the crossing, not the row.
    await admits(client, async () => {
      await insert(client, 'wiki_space_workspace', bindingRow({ id: PROBE }));
      await insert(client, 'wiki_topic', topicRow({ id: id(92) }));
      await insert(client, 'wiki_source', sourceRow({ id: id(72) }));
      await insert(client, 'wiki_changeset_op', opRow({ id: id(62), op: 'challenge', entry_id: ENTRY }));
      await insert(client, 'wiki_changeset_op', opRow({ id: id(63), seq: 1, result_entry_id: ENTRY }));
      await insert(client, 'wiki_exposure', exposureRow({ id: id(82) }));
      await insert(client, 'wiki_entry', entryRow({ id: id(34), supersedes_id: ENTRY }));
    });
  });

  await t.test('a revision number is used once per entry', async () => {
    await seed(client);
    await refuses(() => insert(client, 'wiki_entry_revision', revisionRow({ id: id(43) })),
      'wiki_entry_revision_entry_revision_key',
      'two revision 1s of one entry would be two versions of the same moment in its history');
    // What the key is on is the pair: the next number, and the same number on another entry, are both fine.
    await insert(client, 'wiki_entry_revision', revisionRow({ id: id(43), revision: 2 }));
    await insert(client, 'wiki_entry', entryRow({ id: id(33) }));
    await insert(client, 'wiki_entry_revision', revisionRow({ id: id(44), entry_id: id(33) }));
  });

  // ── the states the contract says a row cannot be in ──────────────────────────────────────────

  await t.test('an entry\'s status, trust, successor and retirement agree', async () => {
    await seed(client);
    const entry = (over: Row) => () => insert(client, 'wiki_entry', entryRow({ id: PROBE, ...over }));
    await refuses(entry({ status: 'superseded', trust: 'confirmed', retired_at: new Date() }),
      'wiki_entry_superseded_chk', 'a superseded entry that names no successor');
    await refuses(entry({ superseded_by_id: ENTRY }), 'wiki_entry_superseded_chk', 'an active entry that names a successor');
    await refuses(entry({ status: 'proposed', trust: 'confirmed' }), 'wiki_entry_trust_status_chk',
      'a proposal that is already trusted');
    await refuses(entry({ trust: 'proposed' }), 'wiki_entry_trust_status_chk', 'active knowledge nobody accepted');
    await refuses(entry({ status: 'rejected', trust: 'owner', retired_at: new Date() }), 'wiki_entry_trust_status_chk',
      'a rejected entry that is still trusted');
    await refuses(entry({ status: 'retired', trust: 'confirmed' }), 'wiki_entry_retired_at_chk',
      'a retired entry with no moment it left');
    await refuses(entry({ retired_at: new Date() }), 'wiki_entry_retired_at_chk', 'a live entry that has left');
    await refuses(entry({ supersedes_id: PROBE }), 'wiki_entry_not_self_chk', 'an entry that supersedes itself');
    await refuses(entry({ valid_from: new Date('2026-09-25T00:00:00Z'), valid_to: new Date('2026-09-24T00:00:00Z') }),
      'wiki_entry_valid_range_chk', 'true until before it was true');
    await refuses(entry({ current_revision: 0 }), 'wiki_entry_current_revision_chk', 'revisions count from 1');
    await refuses(entry({ fields: JSON.stringify('a pitfall') }), 'wiki_entry_fields_chk', 'fields are an object');
    await refuses(entry({ stats: JSON.stringify([]) }), 'wiki_entry_stats_chk', 'stats are an object');
    // A supersession as applyOp writes it: the successor first, then the old entry names it.
    await insert(client, 'wiki_entry', entryRow({ id: id(35), trust: 'confirmed', supersedes_id: ENTRY }));
    await client.query(
      `UPDATE "wiki_entry" SET "status" = 'superseded', "superseded_by_id" = $2, "retired_at" = now() WHERE "id" = $1`,
      [ENTRY, id(35)],
    );
  });

  await t.test('an op carries an entry and a base revision exactly when its kind of op does', async () => {
    await seed(client);
    const op = (over: Row) => () => insert(client, 'wiki_changeset_op', opRow({ id: PROBE, ...over }));
    await refuses(op({ entry_id: ENTRY }), 'wiki_changeset_op_target_chk', 'an add starts a lineage, so it names none');
    await refuses(op({ op: 'reinforce' }), 'wiki_changeset_op_target_chk', 'a reinforce of nothing');
    await refuses(op({ op: 'amend', entry_id: ENTRY }), 'wiki_changeset_op_base_revision_chk',
      'an amend written against no revision: compare-and-set is not optional');
    await refuses(op({ op: 'challenge', entry_id: ENTRY, base_revision: 1 }), 'wiki_changeset_op_base_revision_chk',
      'a challenge carries no base revision');
    await refuses(op({ op: 'retire', entry_id: ENTRY, base_revision: 0 }), 'wiki_changeset_op_base_revision_chk',
      'revisions count from 1');
    await refuses(op({ decision: 'rejected', decided_at: new Date() }), 'wiki_changeset_op_rejected_chk',
      'a rejection names its reason');
    await refuses(op({ decision: 'accepted', decided_at: new Date(), decision_reason: 'duplicate' }),
      'wiki_changeset_op_rejected_chk', 'only a rejection has a reason');
    await refuses(op({ decided_at: new Date() }), 'wiki_changeset_op_decided_chk', 'a pending op already decided');
    await refuses(op({ decision: 'accepted' }), 'wiki_changeset_op_decided_chk', 'a decision at no particular time');
    await refuses(op({ seq: -1 }), 'wiki_changeset_op_seq_chk', 'ops are numbered from 0');
    await refuses(op({ payload: JSON.stringify(['add']) }), 'wiki_changeset_op_payload_chk', 'a payload is an object');
    await refuses(op({ similar: JSON.stringify({}) }), 'wiki_changeset_op_similar_chk', 'similar is a list');
    await insert(client, 'wiki_changeset_op', opRow());
    await refuses(op({}), 'wiki_changeset_op_changeset_seq_key', 'two ops at one place in one changeset');
  });

  await t.test('a changeset, a source, an exposure and a revision hold the shapes the contract gives them', async () => {
    await seed(client);
    const changeset = (over: Row) => () => insert(client, 'wiki_changeset', changesetRow({ id: PROBE, ...over }));
    await refuses(changeset({ status: 'settled' }), 'wiki_changeset_settled_chk', 'settled at no particular time');
    await refuses(changeset({ decided_at: new Date() }), 'wiki_changeset_settled_chk', 'still pending, yet decided');
    await refuses(changeset({ expires_at: null }), 'wiki_changeset_pending_expires_chk', 'a proposal that never expires');
    await refuses(changeset({ idempotency_key: 'propose:1' }), 'wiki_changeset_idempotency_chk',
      'a key without the digest cannot tell a replay from a reuse');

    const source = (over: Row) => () => insert(client, 'wiki_source', sourceRow({ id: PROBE, ...over }));
    await refuses(source({ state: 'deleted', quote: 'the words that were deleted', quote_sha256: 'c'.repeat(64) }),
      'wiki_source_deleted_chk', 'delete means forget: a deleted record keeps no quote');
    await refuses(source({ quote: 'an unhashed quote' }), 'wiki_source_quote_pair_chk', 'a quote and its hash go together');
    await refuses(source({ kind: 'url', ref: 'https://example.invalid/post' }), 'wiki_source_url_tainted_chk',
      'web-derived content that does not say so');
    await refuses(source({ ref: '  ' }), 'wiki_source_ref_chk', 'a source that names nothing');
    await refuses(source({ locator: JSON.stringify('seq 3') }), 'wiki_source_locator_chk', 'a locator is an object');

    await refuses(() => insert(client, 'wiki_exposure', exposureRow({ id: PROBE, session_id: null })),
      'wiki_exposure_push_session_chk', 'a push to no session');
    await admits(client, () => insert(client, 'wiki_exposure', exposureRow({ id: PROBE, session_id: null, channel: 'search' })));
    await refuses(() => insert(client, 'wiki_exposure', exposureRow({ id: PROBE, revision: 0 })),
      'wiki_exposure_revision_chk', 'revisions count from 1');

    const revision = (over: Row) => () => insert(client, 'wiki_entry_revision', revisionRow({ id: PROBE, revision: 2, ...over }));
    await refuses(revision({ author_kind: 'owner' }), 'wiki_entry_revision_owner_author_chk', 'an owner revision names its owner');
    await refuses(revision({ revision: 0 }), 'wiki_entry_revision_revision_chk', 'revisions count from 1');
    await refuses(revision({ content_sha256: 'x'.repeat(64) }), 'wiki_entry_revision_content_sha256_chk', 'a digest is hex');
  });

  await t.test('a space, its bindings and its topics are named and keyed per owner', async () => {
    await seed(client);
    const space = (over: Row) => () => insert(client, 'wiki_space', spaceRow({ id: PROBE, slug: 'probe', ...over }));
    await refuses(space({ slug: 'Not a slug' }), 'wiki_space_slug_chk', 'a slug is lowercase words joined by -');
    for (const url of ['https://github.com/a/b', 'github.com/a/b.git', 'github.com/a/b/', ' github.com/a/b']) {
      await refuses(space({ repo_url_norm: url }), 'wiki_space_repo_url_norm_chk', `${JSON.stringify(url)} is not normalized`);
    }
    await refuses(space({ root_commit_sha: 'ABC' }), 'wiki_space_root_commit_sha_chk', 'a root commit is 40 hex characters');
    await refuses(space({ settings: JSON.stringify([]) }), 'wiki_space_settings_chk', 'settings are an object');
    await refuses(space({ title: ' ' }), 'wiki_space_title_chk', 'a blank title');
    await refuses(space({ slug: 'orbit' }), 'wiki_space_owner_id_slug_key', 'one owner, one slug');
    await refuses(space({ repo_url_norm: 'github.com/wiki-spec/orbit' }), 'wiki_space_owner_id_repo_url_norm_key',
      'one owner, one space per repository');
    // Any number of spaces with no repository behind them.
    await admits(client, async () => {
      await insert(client, 'wiki_space', spaceRow({ id: PROBE, slug: 'notes' }));
      await insert(client, 'wiki_space', spaceRow({ id: id(24), slug: 'more-notes' }));
    });

    await insert(client, 'wiki_space_workspace', bindingRow());
    await refuses(() => insert(client, 'wiki_space_workspace', bindingRow({ id: PROBE })),
      'wiki_space_workspace_workspace_id_key', 'a workspace reads one space');

    await insert(client, 'wiki_topic', topicRow());
    await refuses(() => insert(client, 'wiki_topic', topicRow({ id: PROBE })), 'wiki_topic_space_id_slug_key', 'one space, one slug');
    await refuses(() => insert(client, 'wiki_topic', topicRow({ id: PROBE, slug: 'Testing' })), 'wiki_topic_slug_chk',
      'a topic slug has a space slug\'s shape');

    // An idempotency key is the owner's: reused by the same owner it collides, by another it does not,
    // and a write with no key never collides.
    await insert(client, 'wiki_changeset', changesetRow({ id: id(52), idempotency_key: 'propose:1', request_sha256: 'd'.repeat(64) }));
    await refuses(
      () => insert(client, 'wiki_changeset', changesetRow({ id: PROBE, idempotency_key: 'propose:1', request_sha256: 'e'.repeat(64) })),
      'wiki_changeset_owner_idempotency_key', 'a key the owner already used');
    await admits(client, async () => {
      await insert(client, 'wiki_changeset', changesetRow({
        id: PROBE, owner_id: OTHER, space_id: SPACE_OTHER, idempotency_key: 'propose:1', request_sha256: 'd'.repeat(64),
      }));
      await insert(client, 'wiki_changeset', changesetRow({ id: id(53) }));
      await insert(client, 'wiki_changeset', changesetRow({ id: id(54) }));
    });
  });

  // ── history references, and deleting an owner ────────────────────────────────────────────────

  await t.test('the only foreign keys are the owner and the parents: history ids carry none', async () => {
    const fks = await client.query<{ name: string; source: string; target: string; def: string }>(
      `SELECT conname AS name, conrelid::regclass::text AS source, confrelid::regclass::text AS target,
              pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE contype = 'f' AND conrelid::regclass::text = ANY($1)`,
      [TABLES],
    );
    const edges = fks.rows.map((r) => `${r.name}: ${r.source} -> ${r.target.replace(/"/gu, '')}`).sort();
    assert.deepEqual(edges, [
      'wiki_changeset_op_changeset_fkey: wiki_changeset_op -> wiki_changeset',
      'wiki_changeset_op_entry_fkey: wiki_changeset_op -> wiki_entry',
      'wiki_changeset_op_result_entry_fkey: wiki_changeset_op -> wiki_entry',
      'wiki_changeset_space_fkey: wiki_changeset -> wiki_space',
      'wiki_entry_revision_entry_fkey: wiki_entry_revision -> wiki_entry',
      'wiki_entry_space_fkey: wiki_entry -> wiki_space',
      'wiki_entry_superseded_by_fkey: wiki_entry -> wiki_entry',
      'wiki_entry_supersedes_fkey: wiki_entry -> wiki_entry',
      'wiki_exposure_entry_fkey: wiki_exposure -> wiki_entry',
      'wiki_source_revision_fkey: wiki_source -> wiki_entry_revision',
      'wiki_space_owner_id_fkey: wiki_space -> user',
      'wiki_space_workspace_space_fkey: wiki_space_workspace -> wiki_space',
      'wiki_space_workspace_workspace_fkey: wiki_space_workspace -> workspace',
      'wiki_topic_space_fkey: wiki_topic -> wiki_space',
    ].sort(), 'a wiki foreign key was added or lost; one into session, task or tool_call is a lock this design refuses to take');
    // Every one but the space's own owner key is composite over owner_id, which is what makes it a tenancy key.
    for (const row of fks.rows.filter((r) => r.name !== 'wiki_space_owner_id_fkey')) {
      assert.match(row.def, /^FOREIGN KEY \(\w+, owner_id\) REFERENCES \w+\(id, owner_id\)/u, row.name);
    }
  });

  await t.test('deleting the session and tool call a wiki row names leaves the row, and the id, standing', async () => {
    await seed(client);
    await insert(client, 'wiki_changeset', changesetRow({ id: id(55), session_id: SESSION, tool_call_id: TOOL_CALL }));
    await insert(client, 'wiki_entry_revision', revisionRow({
      id: id(45), revision: 2, author_session_id: SESSION, author_tool_call_id: TOOL_CALL, author_user_id: OWNER, changeset_op_id: id(69),
    }));
    await insert(client, 'wiki_exposure', exposureRow({ id: id(83) }));
    await insert(client, 'wiki_source', sourceRow({ id: id(73), kind: 'tool_call', ref: TOOL_CALL }));

    // The session takes its tool call with it (tool_call's own key); the wiki keeps what it recorded.
    await client.query(`DELETE FROM "session" WHERE "id" = $1`, [SESSION]);
    const toolCalls = await client.query(`SELECT 1 FROM "tool_call" WHERE "id" = $1`, [TOOL_CALL]);
    assert.equal(toolCalls.rowCount, 0, 'the tool call outlived its session: the fixture is not what this case claims');
    const kept = await client.query(
      `SELECT (SELECT "session_id"::text FROM "wiki_changeset" WHERE "id" = $1) AS changeset_session,
              (SELECT "tool_call_id"::text FROM "wiki_changeset" WHERE "id" = $1) AS changeset_tool_call,
              (SELECT "author_session_id"::text FROM "wiki_entry_revision" WHERE "id" = $2) AS revision_session,
              (SELECT "author_tool_call_id"::text FROM "wiki_entry_revision" WHERE "id" = $2) AS revision_tool_call,
              (SELECT "session_id"::text FROM "wiki_exposure" WHERE "id" = $3) AS exposure_session,
              (SELECT "ref" FROM "wiki_source" WHERE "id" = $4) AS source_ref`,
      [id(55), id(45), id(83), id(73)],
    );
    assert.deepEqual(kept.rows[0], {
      changeset_session: SESSION,
      changeset_tool_call: TOOL_CALL,
      revision_session: SESSION,
      revision_tool_call: TOOL_CALL,
      exposure_session: SESSION,
      source_ref: TOOL_CALL,
    }, 'a wiki row lost the id of the history it came from, or was erased with it');
  });

  await t.test('deleting an owner deletes every wiki row it has, through the space, whichever way a row is reached', async () => {
    await seed(client);
    const g = (n: number) => id(1000 + n);
    // A wiki with every table in it: a binding, a topic, a decision superseded by another, both
    // revisions, a source, and a settled changeset whose ops reach both entries — each op reachable
    // from the space through its changeset and through its entries.
    await insert(client, 'wiki_space', spaceRow({ id: SPACE_GONE, owner_id: GONE }));
    await insert(client, 'wiki_space_workspace', bindingRow({ id: g(1), space_id: SPACE_GONE, owner_id: GONE, workspace_id: WS_GONE }));
    await insert(client, 'wiki_topic', topicRow({ id: g(2), space_id: SPACE_GONE, owner_id: GONE }));
    await insert(client, 'wiki_entry', entryRow({ id: g(3), owner_id: GONE, space_id: SPACE_GONE, kind: 'decision', trust: 'confirmed' }));
    await insert(client, 'wiki_entry', entryRow({ id: g(4), owner_id: GONE, space_id: SPACE_GONE, kind: 'decision', supersedes_id: g(3) }));
    await client.query(
      `UPDATE "wiki_entry" SET "status" = 'superseded', "superseded_by_id" = $2, "retired_at" = now() WHERE "id" = $1`,
      [g(3), g(4)],
    );
    await insert(client, 'wiki_entry_revision', revisionRow({ id: g(5), entry_id: g(3), owner_id: GONE }));
    await insert(client, 'wiki_entry_revision', revisionRow({ id: g(6), entry_id: g(4), owner_id: GONE, author_kind: 'owner', author_user_id: GONE }));
    await insert(client, 'wiki_source', sourceRow({ id: g(7), revision_id: g(5), owner_id: GONE }));
    await insert(client, 'wiki_changeset', changesetRow({ id: g(8), owner_id: GONE, space_id: SPACE_GONE, status: 'settled', decided_at: new Date() }));
    await insert(client, 'wiki_changeset_op', opRow({
      id: g(9), changeset_id: g(8), owner_id: GONE, op: 'supersede', entry_id: g(3), base_revision: 1,
      result_entry_id: g(4), result_revision: 1, decision: 'accepted', decided_at: new Date(),
    }));
    await insert(client, 'wiki_changeset_op', opRow({
      id: g(10), changeset_id: g(8), owner_id: GONE, seq: 1, op: 'reinforce', entry_id: g(4), decision: 'auto_applied', decided_at: new Date(),
    }));
    await insert(client, 'wiki_exposure', exposureRow({ id: g(11), owner_id: GONE, entry_id: g(4), session_id: null, channel: 'get' }));
    assert.equal(await rowsOf(client, GONE), 12);
    const others = await rowsOf(client, OWNER);

    // A workspace's own key refuses deleting its user while it exists, so it goes first — and takes its binding.
    await client.query(`DELETE FROM "workspace" WHERE "id" = $1`, [WS_GONE]);
    const bindings = await client.query(`SELECT 1 FROM "wiki_space_workspace" WHERE "id" = $1`, [g(1)]);
    assert.equal(bindings.rowCount, 0, 'a deleted workspace is still bound');
    await client.query(`DELETE FROM "user" WHERE "id" = $1`, [GONE]);
    assert.equal(await rowsOf(client, GONE), 0, 'a deleted owner left wiki rows behind');
    assert.equal(await rowsOf(client, OWNER), others, 'deleting one owner changed another owner\'s wiki');
  });

  // ── keyword search ───────────────────────────────────────────────────────────────────────────

  await t.test('keyword search reaches its trigram index through wiki_entry_search_text, and only that way', async () => {
    await seed(client);
    // The text: title, summary, aliases, then every string inside fields and none of their names;
    // * and ` removed as 0095 removes them, _ kept.
    const text = await client.query<{ text: string }>(
      `SELECT wiki_entry_search_text($1, $2, $3, $4::jsonb) AS text`,
      [
        'A pg **spec** skips',
        'It exits `0`.',
        ['假绿', 'false_green'],
        JSON.stringify({ trigger: { paths: ['src/apiserver/'], commands: [] }, fix: 'Use scripts/run-pg-spec.sh', n: 5, flag: true }),
      ],
    );
    assert.equal(text.rows[0].text, 'A pg spec skips It exits 0. 假绿 false_green ["Use scripts/run-pg-spec.sh", "src/apiserver/"]');

    await insert(client, 'wiki_entry', entryRow({
      id: id(36),
      title: 'Migration numbers collide only on merge',
      summary: 'Two branches each take the next free number, and the ledger breaks after the merge.',
      aliases: ['迁移撞号', 'migration collision'],
      fields: JSON.stringify({ fix: 'Renumber the **later** one to the next free number.' }),
    }));
    // Freshly written rows wait in GIN's pending list, which the planner prices as a scan; flush it
    // so the plan below is about the expression and not about when autovacuum last ran.
    await client.query(`SELECT gin_clean_pending_list('wiki_entry_search_trgm'::regclass)`);
    const find = async (pattern: string) => (await client.query<{ id: string }>(
      `SELECT "id"::text AS id FROM "wiki_entry"
        WHERE "owner_id" = $1 AND wiki_entry_search_text("title", "summary", "aliases", "fields") ILIKE $2`,
      [OWNER, pattern],
    )).rows.map((r) => r.id);
    // What a reader types finds it: a Chinese alias, and a phrase whose stored form carries marks.
    assert.deepEqual(await find('%迁移撞号%'), [id(36)]);
    assert.deepEqual(await find('%renumber the later one%'), [id(36)]);

    // `enable_seqscan`/`enable_indexscan` off leave a bitmap scan as the only cheap plan, and only an
    // index that can answer the predicate offers one. So an index named in the plan covers the shape.
    const planFor = async (predicate: string): Promise<string> => {
      await client.query('BEGIN');
      try {
        await client.query('SET LOCAL enable_seqscan = off');
        await client.query('SET LOCAL enable_indexscan = off');
        const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT "id" FROM "wiki_entry" WHERE ${predicate}`);
        return plan.rows.map((row) => row['QUERY PLAN']).join('\n');
      } finally {
        await client.query('ROLLBACK');
      }
    };
    assert.match(
      await planFor(`wiki_entry_search_text("title", "summary", "aliases", "fields") ILIKE '%renumber the later%'`),
      /wiki_entry_search_trgm/u,
      'a query calling wiki_entry_search_text over the four columns does not reach the index built on it');
    // The same words spelled any other way scan every row: the function is the only way in.
    assert.doesNotMatch(
      await planFor(`("title" || ' ' || "summary") ILIKE '%renumber the later%'`),
      /wiki_entry_search_trgm/u,
      'an expression that is not the index\'s reached it');
  });
});
