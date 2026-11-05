/**
 * The history backfill's command and its close (contracts/wiki.contract.json `maintenance.job.server.backfill`,
 * docs/wiki-memory-claims-design.md §5), against a real PostgreSQL, through the command as an operator runs it:
 *
 *   1. `run` makes one `maintain` job and its run row, with no `due`, and writes nothing else; it refuses, with nothing
 *      written, what it cannot do: no reason, more than 20 sessions, a session not of the space or not at rest, a note not
 *      of the space, a space that is off or not Automatic, and a run of the space that has not ended;
 *   2. `downgrade` reports by default and writes nothing, not a row version; with `--apply` it needs a reason, and moves only
 *      the live `auto` entries with a note and no first-hand source on their current revision, by the evidence rule's own
 *      function, with no revision and an `activity` row; run again, it changes nothing;
 *   3. it works in batches, and an entry that moved since it was read is left as it is, and counted; and
 *   4. the entries citing a note join an op's neighbours for the maintenance run alone.
 *
 * The job itself is wiki-maintain-job.pg.spec.ts's.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki/wiki-backfill.pg.spec.ts
 *
 * Not destructive: it writes only rows under its own account, and deletes them afterwards.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { uuidToBase62, WIKI_BACKFILL, type WikiOpOutcome } from '@orbit/shared';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { wikiMaintainJobPrincipal } from '../wiki-worker/wiki-maintain-job';
import { WikiService, type WikiNoteDowngradeReport, type WikiPrincipal } from './wiki.service';

const URL_ = process.env.COORDINATOR_PG_URL;
const skip = !URL_;
const CLI = path.resolve(__dirname, 'wiki-backfill.cli.js');

interface Harness {
  sql: Client;
  prisma: PrismaClient;
  service: WikiService;
  ownerId: string;
}

let harness: Promise<Harness> | undefined;

function boot(): Promise<Harness> {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL_);
    const sql = new Client({ connectionString: URL_, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const prisma = prismaClientFor(URL_ as string);
    const ownerId = randomUUID();
    await prisma.user.create({ data: { id: ownerId, email: `wiki-backfill-${ownerId}@wiki.invalid`, name: 'backfill spec', passwordHash: 'x' } });
    return { sql, prisma, service: new WikiService(prisma as unknown as PrismaService), ownerId };
  })();
  return harness;
}

after(async () => {
  if (!harness) return;
  const { prisma, sql, ownerId } = await harness;
  await prisma.activity.deleteMany({ where: { payload: { path: ['userId'], equals: ownerId } } }).catch(() => undefined);
  await prisma.wikiSpace.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.workspace.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await sql.end().catch(() => undefined);
});

/** The command as an operator runs it, with what the apiserver's container has in its environment. */
async function cli(...args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: URL_, NO_COLOR: '1' };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
  const code = await new Promise<number | null>((resolve) => child.once('close', resolve));
  return { code, stdout, stderr };
}

interface Space {
  id: string;
  workspaceId: string;
}

/** A space of the spec's own with a workspace on its repository, its maintenance on and Automatic unless it is told otherwise. */
async function space(h: Harness, over: { reviewMode?: string; enabled?: boolean } = {}): Promise<Space> {
  const id = randomUUID();
  const repo = `github.com/example/backfill-${id.slice(0, 8)}`;
  const workspaceId = randomUUID();
  await h.prisma.workspace.create({ data: { id: workspaceId, ownerId: h.ownerId, name: 'backfill checkout', workDir: '/tmp/backfill-spec', repoUrl: `https://${repo}.git` } });
  await h.prisma.wikiSpace.create({
    data: {
      id, ownerId: h.ownerId, slug: `backfill-${id.slice(0, 8)}`, title: 'app', repoUrlNorm: repo, rootCommitSha: 'b'.repeat(40),
      settings: { reviewMode: over.reviewMode ?? 'automatic', maintenance: { enabled: over.enabled ?? true, workspaceId } },
    },
  });
  return { id, workspaceId };
}

/** A session of the space, at rest unless it is told otherwise. */
async function session(h: Harness, workspaceId: string, over: { status?: 'RUNNING' | 'SUCCEEDED'; deleted?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  await h.prisma.session.create({
    data: {
      id, title: 'a session', prompt: 'p', ownerId: h.ownerId, creatorId: h.ownerId, dispatchOrigin: 'USER', status: over.status ?? 'SUCCEEDED',
      lastTurnAt: new Date(), workspaceId, ...(over.deleted ? { deletedAt: new Date() } : {}),
    },
  });
  return id;
}

const NOTE_WORDS = 'The upload test fails with ECONNREFUSED until the fixture returns the url it listens on, whichever port it took.';

async function note(h: Harness, spaceId: string, body: string = NOTE_WORDS): Promise<string> {
  const text = `---\ntype: project\n---\n${body}\n`;
  const contentSha256 = createHash('sha256').update(text).digest('hex');
  return (await h.prisma.wikiNote.create({ data: { spaceId, ownerId: h.ownerId, path: 'memory/port.md', text, contentSha256 }, select: { id: true } })).id;
}

/** A source as a revision stores it. */
type Cited = { kind: string; ref: string; state?: string; locator?: Record<string, unknown> };

/** An entry at revision 1 (or at `current`, whose earlier revisions cite `before`), with these sources on its current revision. */
async function entry(
  h: Harness,
  spaceId: string,
  cited: readonly Cited[],
  over: { trust?: string; status?: string; kind?: string; current?: number; before?: readonly Cited[] } = {},
): Promise<string> {
  const current = over.current ?? 1;
  const fields = { definition: 'x', boundaries: 'y' };
  const title = `Entry ${randomUUID().slice(0, 8)}`;
  const { id } = await h.prisma.wikiEntry.create({
    data: {
      ownerId: h.ownerId, spaceId, kind: over.kind ?? 'concept', title, summary: 'What it says.', status: over.status ?? 'active', trust: over.trust ?? 'auto',
      currentRevision: current, fields, topics: [], anchors: [], ...(over.status === 'retired' ? { retiredAt: new Date(), validFrom: new Date(0), validTo: new Date() } : {}),
    },
    select: { id: true },
  });
  for (let revision = 1; revision <= current; revision += 1) {
    const row = await h.prisma.wikiEntryRevision.create({
      data: { entryId: id, ownerId: h.ownerId, revision, title, summary: 'What it says.', fields, topics: [], aliases: [], anchors: [], contentSha256: 'a'.repeat(64), authorKind: 'system' },
      select: { id: true },
    });
    for (const source of revision === current ? cited : over.before ?? []) {
      await h.prisma.wikiSource.create({ data: { revisionId: row.id, ownerId: h.ownerId, kind: source.kind, ref: source.ref, locator: (source.locator ?? {}) as never, state: source.state ?? 'live' } });
    }
  }
  return id;
}

/** A tool's call recorded in a session: the row a `tool_call` source names. */
async function toolCall(h: Harness, sessionId: string, name: string, input: Record<string, unknown>, output: string): Promise<string> {
  const id = randomUUID();
  await h.sql.query(`INSERT INTO "tool_call"("id","session_id","name","tool_use_id","input","output") VALUES ($1,$2,$3,$4,$5,$6)`, [
    id, sessionId, name, `toolu_${randomUUID().replace(/-/gu, '')}`, JSON.stringify(input), JSON.stringify(output),
  ]);
  return id;
}

/** Every row of the wiki a downgrade could write, at its physical version: a row anything wrote to, even the same values, has another. */
async function versions(h: Harness): Promise<unknown> {
  const of = async (from: string) => (await h.sql.query(`SELECT x.id::text, x.ctid::text, x.xmin::text ${from} ORDER BY x.id`, [h.ownerId])).rows;
  return {
    entries: await of('FROM "wiki_entry" x WHERE x."owner_id" = $1'),
    revisions: await of('FROM "wiki_entry_revision" x WHERE x."owner_id" = $1'),
    sources: await of('FROM "wiki_source" x WHERE x."owner_id" = $1'),
    changesets: await of('FROM "wiki_changeset" x WHERE x."owner_id" = $1'),
    activity: await of(`FROM "activity" x WHERE x."payload"->>'userId' = $1::text`),
  };
}

const trustOf = async (h: Harness, id: string) => (await h.prisma.wikiEntry.findUniqueOrThrow({ where: { id }, select: { trust: true } })).trust;
const jobsOf = (h: Harness, spaceId: string) => h.prisma.wikiJob.findMany({ where: { ownerId: h.ownerId, spaceId }, select: { id: true, kind: true, state: true, input: true } });
const runsOf = (h: Harness, spaceId: string) => h.prisma.wikiMaintenanceRun.findMany({ where: { ownerId: h.ownerId, spaceId } });

// ── run ─────────────────────────────────────────────────────────────────────────────────────────

test('run makes one maintain job over the sessions it names, with why, and its run row with no due: the cursor is not read', { skip }, async () => {
  const h = await boot();
  const { id, workspaceId } = await space(h);
  const named = await session(h, workspaceId);
  const noted = await session(h, workspaceId);
  const noteId = await note(h, id);
  const other = await note(h, id, 'A second note of the same session, about something else in the fixture.');

  // Each id in either spelling: what a client showed, or the row's.
  const made = await cli('run', '--space', uuidToBase62(id), '--reason', 'first batch of the backfill', '--session', named, '--session', `${uuidToBase62(noted)}:${uuidToBase62(noteId)},${other}`);
  assert.equal(made.code, 0, made.stderr);
  const answer = JSON.parse(made.stdout) as { jobId: string; runId: string; sessions: number };
  assert.equal(answer.sessions, 2);

  const jobs = await jobsOf(h, id);
  assert.equal(jobs.length, 1);
  assert.deepEqual([jobs[0]!.id, jobs[0]!.kind, jobs[0]!.state], [answer.jobId, 'maintain', 'queued']);
  assert.deepEqual(jobs[0]!.input, {
    runId: answer.runId,
    backfill: { reason: 'first batch of the backfill', sessions: [{ sessionId: named, noteIds: [] }, { sessionId: noted, noteIds: [noteId, other] }] },
  });
  const runs = await runsOf(h, id);
  assert.equal(runs.length, 1);
  assert.deepEqual([runs[0]!.id, runs[0]!.jobId, runs[0]!.due, runs[0]!.expectAt, runs[0]!.outcome], [answer.runId, answer.jobId, null, null, null]);
  assert.equal(await h.prisma.wikiCursor.count({ where: { spaceId: id } }), 0, 'no cursor row is even made');

  const second = await cli('run', '--space', id, '--reason', 'second batch', '--session', named);
  assert.equal(second.code, 1);
  assert.match(second.stderr, /has not ended/u, 'one run of a space at a time');
  assert.equal((await jobsOf(h, id)).length, 1);
});

test('run refuses, with nothing written, what it cannot do', { skip }, async () => {
  const h = await boot();
  const { id, workspaceId } = await space(h);
  const ok = await session(h, workspaceId);
  const foreign = await space(h);
  const refused = async (args: readonly string[], why: RegExp, spaceId = id) => {
    const answer = await cli('run', '--space', spaceId, ...args);
    assert.equal(answer.code, 1, `${why}: ${answer.stdout}`);
    assert.match(answer.stderr, why);
    assert.equal(answer.stdout, '');
    assert.equal((await jobsOf(h, spaceId)).length, 0, String(why));
    assert.equal((await runsOf(h, spaceId)).length, 0, String(why));
  };
  await refused(['--session', ok], /a reason is required/u);
  await refused(['--reason', '   ', '--session', ok], /a reason is required/u);
  await refused(['--reason', 'x'.repeat(WIKI_BACKFILL.reasonMaxChars + 1), '--session', ok], /at most 500/u);
  await refused(['--reason', 'why'], /at least one session/u);
  await refused(['--reason', 'why', '--session', ok, '--session', ok], /named twice/u);
  const many = await Promise.all(Array.from({ length: WIKI_BACKFILL.sessionsMax + 1 }, () => session(h, workspaceId)));
  await refused(['--reason', 'why', ...many.flatMap((one) => ['--session', one])], /at most 20 sessions, and this names 21/u);
  const elsewhere = await session(h, foreign.workspaceId);
  await refused(['--reason', 'why', '--session', ok, '--session', elsewhere], new RegExp(`not a session of this space that has come to rest: ${elsewhere}`, 'u'));
  await refused(['--reason', 'why', '--session', randomUUID()], /not a session of this space/u);
  await refused(['--reason', 'why', '--session', await session(h, workspaceId, { status: 'RUNNING' })], /not a session of this space/u);
  await refused(['--reason', 'why', '--session', await session(h, workspaceId, { deleted: true })], /not a session of this space/u);
  const theirs = await note(h, foreign.id);
  await refused(['--reason', 'why', '--session', `${ok}:${theirs}`], new RegExp(`not a note of this space: ${theirs}`, 'u'));

  const manual = await space(h, { reviewMode: 'tiered' });
  await refused(['--reason', 'why', '--session', await session(h, manual.workspaceId)], /only an Automatic space/u, manual.id);
  const off = await space(h, { enabled: false });
  await refused(['--reason', 'why', '--session', await session(h, off.workspaceId)], /maintenance is off/u, off.id);
  const gone = await cli('run', '--space', randomUUID(), '--reason', 'why', '--session', ok);
  assert.equal(gone.code, 1);
  assert.match(gone.stderr, /no such wiki space/u);

  // Twenty is one a backfill may name.
  const twenty = await cli('run', '--space', id, '--reason', 'why', ...many.slice(0, WIKI_BACKFILL.sessionsMax).flatMap((one) => ['--session', one]));
  assert.equal(twenty.code, 0, twenty.stderr);
});

test('the command asked wrongly says how to ask, and exits 2', { skip }, async () => {
  for (const args of [[], ['nonsense', '--space', randomUUID()], ['run'], ['run', '--space', 'not an id'], ['run', '--space', randomUUID(), '--session', 'not an id'], ['downgrade', '--space', randomUUID(), '--unknown'], ['downgrade', 'extra', '--space', randomUUID()]]) {
    const answer = await cli(...args);
    assert.equal(answer.code, 2, args.join(' '));
    assert.match(answer.stderr, /^usage: wiki-backfill\.cli\.js/u);
  }
});

// ── downgrade ───────────────────────────────────────────────────────────────────────────────────

test('downgrade reports and writes nothing by default; with --apply it moves only what the evidence rule says, with no revision; run again it changes nothing', { skip }, async () => {
  const h = await boot();
  const { id, workspaceId } = await space(h);
  const elsewhere = await space(h);
  const noted = await note(h, id);
  const cite = { kind: 'note', ref: noted };
  const records = await session(h, workspaceId);

  const reply = randomUUID();
  await h.sql.query(`INSERT INTO "run_event"("id","session_id","seq","type","payload") VALUES ($1,$2,1,'assistant',$3)`, [reply, records, JSON.stringify({ text: 'The port is read at import.' })]);
  const turn = randomUUID();
  await h.sql.query(
    `INSERT INTO "conversation_turn"("id","session_id","seq","client_turn_id","content","status","kind","send_intent") VALUES ($1,$2,1,$3,$4,'ANSWERED','message','NEXT_TURN')`,
    [turn, records, `spec-${randomUUID()}`, 'Keep the port out of the fixture.'],
  );
  const bash = await toolCall(h, records, 'Bash', { command: 'npm test' }, 'connect ECONNREFUSED 127.0.0.1:9000');
  const repeats = await toolCall(h, records, 'Read', { file_path: '/tmp/saved.txt' }, `1\t${NOTE_WORDS}`);
  const wrote = await toolCall(h, records, 'Edit', { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' }, 'File updated.');

  // Moved: live, `auto`, a note on the current revision, nothing first-hand there.
  const moved = {
    noteOnly: await entry(h, id, [cite], { kind: 'pitfall' }),
    agentWords: await entry(h, id, [cite, { kind: 'event', ref: reply }], { kind: 'decision' }),
    fileWrite: await entry(h, id, [cite, { kind: 'tool_call', ref: wrote }]),
    repeatsNote: await entry(h, id, [cite, { kind: 'tool_call', ref: repeats }]),
    commitWithNoText: await entry(h, id, [cite, { kind: 'commit', ref: 'c'.repeat(40) }]),
    deletedFirstHand: await entry(h, id, [cite, { kind: 'tool_call', ref: bash, state: 'deleted' }]),
    firstHandOnAnOlderRevision: await entry(h, id, [cite], { current: 2, before: [{ kind: 'tool_call', ref: bash }] }),
  };
  // Left as they are.
  const left = {
    toolResult: await entry(h, id, [cite, { kind: 'tool_call', ref: bash }]),
    ownerWords: await entry(h, id, [cite, { kind: 'turn', ref: turn }]),
    ownerWordsThroughTheLocator: await entry(h, id, [cite, { kind: 'turn', ref: records, locator: { seq: 1, turnId: turn } }]),
    noNote: await entry(h, id, [{ kind: 'event', ref: reply }]),
    noteOnAnOlderRevision: await entry(h, id, [{ kind: 'event', ref: reply }], { current: 2, before: [cite] }),
    deletedNote: await entry(h, id, [{ kind: 'note', ref: noted, state: 'deleted' }]),
    unreviewed: await entry(h, id, [cite], { trust: 'unreviewed' }),
    confirmed: await entry(h, id, [cite], { trust: 'confirmed' }),
    owner: await entry(h, id, [cite], { trust: 'owner' }),
    retired: await entry(h, id, [cite], { status: 'retired' }),
    otherSpace: await entry(h, elsewhere.id, [{ kind: 'note', ref: await note(h, elsewhere.id) }]),
  };
  const movedIds = Object.values(moved).sort();
  const trustBefore = Object.fromEntries(await Promise.all(Object.entries(left).map(async ([name, entryId]) => [name, await trustOf(h, entryId)])));

  const before = await versions(h);
  const asked = await cli('downgrade', '--space', id);
  assert.equal(asked.code, 0, asked.stderr);
  const reported = JSON.parse(asked.stdout) as WikiNoteDowngradeReport;
  assert.equal(reported.apply, false);
  assert.equal(reported.noFirstHand, movedIds.length);
  assert.equal(reported.firstHand, 3, 'the tool result, and the owner\'s words either way');
  assert.equal(reported.examined, movedIds.length + 3);
  assert.equal(reported.downgraded, 0);
  assert.deepEqual([...reported.entryIds].sort(), movedIds);
  assert.deepEqual(reported.byKind, { pitfall: 1, decision: 1, concept: movedIds.length - 2 });
  assert.deepEqual(await versions(h), before, 'by default not a row is written');

  const noReason = await cli('downgrade', '--space', id, '--apply');
  assert.equal(noReason.code, 1);
  assert.match(noReason.stderr, /a reason is required/u);
  assert.deepEqual(await versions(h), before);

  const applied = await cli('downgrade', '--space', id, '--apply', '--reason', 'the backfill is over');
  assert.equal(applied.code, 0, applied.stderr);
  const done = JSON.parse(applied.stdout) as WikiNoteDowngradeReport;
  assert.deepEqual([done.apply, done.noFirstHand, done.downgraded, done.moved], [true, movedIds.length, movedIds.length, 0]);
  for (const [name, entryId] of Object.entries(moved)) assert.equal(await trustOf(h, entryId), 'unreviewed', name);
  for (const [name, entryId] of Object.entries(left)) assert.equal(await trustOf(h, entryId), trustBefore[name], name);

  const after_ = await versions(h) as { entries: Array<{ id: string; xmin: string }>; revisions: unknown; sources: unknown; changesets: unknown; activity: Array<{ id: string }> };
  const was = before as typeof after_;
  assert.deepEqual(after_.revisions, was.revisions, 'no revision is written');
  assert.deepEqual(after_.sources, was.sources, 'and no source');
  assert.deepEqual(after_.changesets, was.changesets, 'and no changeset');
  const untouched = new Set(Object.values(left));
  const rowOf = (rows: typeof after_.entries, entryId: string) => rows.find((row) => row.id === entryId);
  for (const entryId of untouched) assert.deepEqual(rowOf(after_.entries, entryId), rowOf(was.entries, entryId), 'what it leaves alone it does not write');
  const revisionsNow = await h.prisma.wikiEntry.findMany({ where: { id: { in: movedIds } }, select: { currentRevision: true, id: true } });
  assert.ok(revisionsNow.every((row) => row.currentRevision === (row.id === moved.firstHandOnAnOlderRevision ? 2 : 1)), 'its revision did not move');

  // The one trail it leaves: who, why and which.
  const trail = await h.prisma.activity.findMany({ where: { type: WIKI_BACKFILL.downgradeActivity, payload: { path: ['spaceId'], equals: id } } });
  assert.equal(trail.length, 1);
  assert.equal(trail[0]!.actorId, null);
  const payload = trail[0]!.payload as { userId: string; reason: string; entryIds: string[] };
  assert.deepEqual([payload.userId, payload.reason], [h.ownerId, 'the backfill is over']);
  assert.deepEqual([...payload.entryIds].sort(), movedIds);

  // Run again: nothing is left for it to write.
  const settled = await versions(h);
  const again = JSON.parse((await cli('downgrade', '--space', id, '--apply', '--reason', 'the backfill is over')).stdout) as WikiNoteDowngradeReport;
  assert.deepEqual([again.examined, again.firstHand, again.noFirstHand, again.downgraded, again.moved], [3, 3, 0, 0, 0]);
  assert.deepEqual(await versions(h), settled, 'running it again changes nothing, not a row version');
});

test('downgrade goes in batches, each with its trail, and leaves an entry that moved since it was read, counting it', { skip }, async () => {
  const h = await boot();
  const { id } = await space(h);
  const noted = await note(h, id);
  const ids = await Promise.all(Array.from({ length: 5 }, () => entry(h, id, [{ kind: 'note', ref: noted }])));

  const read = await h.service.downgradeNoteEntries(h.ownerId, id, { batchSize: 2 });
  assert.deepEqual([read.batches, read.examined, read.noFirstHand, read.downgraded], [3, 5, 5, 0]);
  assert.deepEqual(read.entryIds, [...ids].sort(), 'in the order of their ids');

  // The owner confirms one while the close is under way: it read `auto`, and its write waits on the row the owner holds.
  const held = [...ids].sort()[0]!;
  const owner = new Client({ connectionString: URL_ });
  await owner.connect();
  await owner.query('BEGIN');
  await owner.query(`UPDATE "wiki_entry" SET "trust" = 'confirmed' WHERE "id" = $1`, [held]);
  const running = h.service.downgradeNoteEntries(h.ownerId, id, { apply: true, reason: 'the backfill is over', batchSize: 2 });
  // Until its first batch's UPDATE waits on that row, the only row anything waits on here.
  for (let i = 0; i < 400; i += 1) {
    const { rows } = await h.sql.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE "wait_event_type" = 'Lock' AND "query" ILIKE '%wiki_entry%'`);
    if ((rows[0] as { n: number }).n > 0) break;
    await delay(25);
  }
  await owner.query('COMMIT');
  await owner.end();
  const done = await running;
  assert.deepEqual([done.batches, done.noFirstHand, done.downgraded, done.moved], [3, 5, 4, 1]);
  assert.equal(await trustOf(h, held), 'confirmed', 'the owner\'s word stands');
  for (const entryId of ids.filter((one) => one !== held)) assert.equal(await trustOf(h, entryId), 'unreviewed');
  const trail = await h.prisma.activity.findMany({ where: { type: WIKI_BACKFILL.downgradeActivity, payload: { path: ['spaceId'], equals: id } } });
  assert.equal(trail.length, 3, 'one for each batch that wrote');
  const named = trail.flatMap((row) => (row.payload as { entryIds: string[] }).entryIds);
  assert.deepEqual(named.sort(), ids.filter((one) => one !== held).sort(), 'naming what each wrote, and not what moved');
});

// ── similar[] ───────────────────────────────────────────────────────────────────────────────────

test('the entries citing a note join an op\'s neighbours for the maintenance run alone, and only those live at their current revision', { skip }, async () => {
  const h = await boot();
  const { id, workspaceId } = await space(h);
  const noted = await note(h, id);
  const cite = { kind: 'note', ref: noted };
  const live = await entry(h, id, [cite]);
  const unreviewed = await entry(h, id, [cite], { trust: 'unreviewed' });
  await entry(h, id, [cite], { status: 'retired' });
  await entry(h, id, [{ kind: 'event', ref: randomUUID() }], { current: 2, before: [cite] });
  await entry(h, id, [{ kind: 'note', ref: await note(h, id, 'Another note of the space, about something else in the fixture.') }]);

  const records = await session(h, workspaceId);
  const bash = await toolCall(h, records, 'Bash', { command: 'npm test' }, 'connect ECONNREFUSED 127.0.0.1:9000');
  const draft = (title: string) => ({
    op: 'add',
    entry: {
      kind: 'pitfall', title, summary: 'What the space knows about this.',
      fields: { trigger: { paths: ['scripts/release.sh'], commands: ['npm test'] }, symptom: 'It fails.', cause: 'The import.', fix: 'Return the url.' },
    },
    sources: [{ kind: 'tool_call', ref: bash }],
  });
  const promptedBy = [{ noteId: noted, file: 'port.md' }];
  const neighbours = async (principal: WikiPrincipal, title: string) => {
    const answer = await h.service.submitChangeset(principal, id, { rationale: 'what a note prompted', ops: [draft(title)] }, { promptedBy });
    const outcome = (answer.ops as WikiOpOutcome[])[0] as { status: string; similar?: Array<{ id: string }> };
    assert.equal(outcome.status, 'pending', JSON.stringify(outcome));
    return (outcome.similar ?? []).map((near) => near.id);
  };

  const job = randomUUID();
  assert.deepEqual((await neighbours(wikiMaintainJobPrincipal(h.ownerId, job), 'Zzyzx quux frobnicate')).sort(), [live, unreviewed].sort(), 'by what they came from, and live');
  assert.deepEqual(await neighbours({ origin: 'agent', ownerId: h.ownerId, userId: null, sessionId: records, toolCallId: null }, 'Qwerty wibble wobble'), [], 'an agent is told nothing of the kind, whatever it is handed');
});
