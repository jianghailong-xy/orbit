/**
 * Which conversation authored each VERSION of a project's acceptance criteria (migration 0251).
 *
 * WHAT WAS MISSING
 * ----------------
 * Project acceptance §6 says that at settlement, a criterion written by the very session whose
 * evidence is being counted does not count. That sentence reads a fact the database did not hold:
 * `project_acceptance_criterion_definition` records what a criterion says and which revision it is
 * on, and nothing anywhere recorded WHO wrote it. Nothing to read means the rule can only be
 * decided one way, which is not deciding it.
 *
 * WHY A TABLE AND NOT A COLUMN
 * ----------------------------
 * That relation's column list is asserted literally by three suites
 * (`criteria-confirmation-removal`, `failure-continuation-removal`,
 * `verification-subject-guard-removal`), and they are right to: the acceptance wall coming through
 * every removal column for column is the thing they preserve. Authorship is not part of that wall
 * — it is a fact about the WRITE, not about the assertion — so it is its own relation, and `(a)`
 * below runs the wall's own census here so this file witnesses that the wall did not move.
 *
 * WHY ONE ROW PER `(definitionId, revision)`
 * ------------------------------------------
 * A rewritten criterion is a new version, and the rewrite may come from a different session than
 * the original — which is exactly what §6 asks about. So each version answers for itself, `(2)`.
 * Moving a criterion up the list is NOT authoring it: reordering leaves the revision where it was,
 * the write lands on a primary key that already exists, and the first author stands, `(3)`.
 *
 * WHY THREE `authoredByType`s AND NOT A NULLABLE SESSION
 * -----------------------------------------------------
 * `USER` (the owner-authenticated channel) and `SYSTEM` (what 0251 backfilled, meaning nobody
 * knows) both carry a NULL session, so the session column alone cannot tell them apart. Collapsed
 * into one row, a separation-of-duties gate has only two possible behaviours towards every
 * criterion that predates 0251: admit all of them as owner-written, or refuse all of them as
 * unattributable. `(4)` and `(5)` hold those two apart.
 *
 * TWO ROUTES TO A DEFINITION, AND ONE ANSWER ABOUT WHO WROTE IT
 * --------------------------------------------------------------
 * An edit that plainly tightens the ruler is applied where it is made. One that rewords a
 * criterion is not: `classifyCriteriaEdit` cannot read the direction of prose, so it is held as a
 * proposal and reaches the definitions only when the account owner approves it. A rewrite is
 * precisely what §6 asks about — the same criterion, said differently, possibly by somebody else
 * — so a fixture that could not reword anything could not pose the question. `state()` below
 * therefore sees an edit through whichever route it takes, answering the proposals it files as
 * the owner would. What that must NOT do is move the author: the version the owner approves was
 * composed by the session that asked for it, and permitting a change is not writing one. Every
 * case below names the session that made the edit, whichever route carried it.
 *
 * WHY THIS IS A `.pg.spec`
 * ------------------------
 * Every fact here is produced the way the product produces it, and the numbers under test are the
 * database's own. `revision` is decided by `project_acceptance_definition_normalize`, a BEFORE
 * trigger that OVERWRITES the value the service sends, so a double handing the service canned rows
 * would be testing this file's arithmetic instead of the trigger's. `(4)` replays the backfill
 * statement read out of 0251 itself rather than a retyped copy of it. Every row asserted is read
 * back with SQL, never through the projection that wrote it.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/projects/criteria-authorship.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { RunStatus, SessionDispatchOrigin } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from './coordinator-pg-test-safety';
import { ProjectsService } from './projects.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const TABLE = 'project_criteria_authorship';

const MIGRATION = readFileSync(
  path.resolve(__dirname, `../../prisma/migrations/0251_${TABLE}/migration.sql`), 'utf8',
);

/** The verification method the criteria declare. Never the thing under test here. */
const METHOD = 'A person reads the criterion and says whether it holds';

const FIRST = 'the authorship of a criterion version is recorded';
const SECOND = 'a rewrite is a new version and may have a new author';
const REWORDED = 'a rewrite is a new version, and it answers for itself';

/**
 * The acceptance wall as `format_type` spells it, copied from
 * `criteria-confirmation-removal.pg.spec.ts` so that this file — the one thing this task's
 * acceptance command runs — fails if 0251 put authorship on the wall after all.
 */
const DEFINITION_COLUMNS =
  'id:uuid!, project_id:uuid!, ordinal:integer!, text:text!, revision:integer!, '
  + 'content_hash:character(64)!, created_at:timestamp(3) without time zone!, '
  + 'updated_at:timestamp(3) without time zone!, verification_method:text!, '
  + 'completion_criterion_override_reason:text, semantic_revision:integer!, '
  + 'semantic_hash:character(64)!';

/** What `update` hands back instead of applying an edit whose direction cannot be read. */
interface HeldEdit {
  intentId: string;
  baselineSeal: string;
}

/** One stored authorship row, read from the table rather than from the service that wrote it. */
interface AuthorshipRow {
  definition_id: string;
  revision: number;
  project_id: string;
  owner_id: string;
  authored_by_session_id: string | null;
  authored_by_type: string;
}

/** The backfill exactly as 0251 runs it — read out of the migration, not retyped. */
function backfillStatement(): string {
  const start = MIGRATION.indexOf(`INSERT INTO "${TABLE}"`);
  assert.ok(start >= 0, `0251 no longer carries a backfill into ${TABLE}`);
  const end = MIGRATION.indexOf(';', start);
  assert.ok(end > start, 'the backfill statement is unterminated');
  return MIGRATION.slice(start, end + 1);
}

test('every version of a project’s criteria records the conversation that wrote it', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const prisma: PrismaClient = prismaClientFor(url);
  t.after(async () => {
    await prisma.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const projects = new ProjectsService(prisma as unknown as PrismaService);

  const ownerId = randomUUID();
  const projectId = randomUUID();
  await prisma.user.create({
    data: {
      id: ownerId,
      email: `authorship-${ownerId}@criteria.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await prisma.project.create({
    data: { id: projectId, ownerId, title: 'The project whose ruler has authors' },
  });

  /**
   * An acting session, as `sessions.create` would have written it. `USER` and not the judgment
   * origin: `refuseHumanOnlyAction` refuses only the latter from editing criteria at all, and the
   * session that CAN edit them is precisely the one §6 needs identified.
   */
  async function actingSession(title: string): Promise<string> {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        title,
        prompt: 'act on this project',
        provider: 'claude',
        status: RunStatus.RUNNING,
        dispatchOrigin: SessionDispatchOrigin.USER,
        startsTaskWork: false,
      },
    });
    return id;
  }

  /**
   * State the whole collection, through the runner door when a session is named — and see it
   * through to the definitions whatever route it has to take to get there.
   *
   * TWO ROUTES, ONE WRITER. An edit that plainly tightens the ruler lands where it is made. An
   * edit that rewords a criterion does not: `classifyCriteriaEdit` cannot read the direction of
   * prose, so it comes out `WEAKENING`, is held as a proposal, and reaches the definitions only
   * when the account owner approves it. A rewrite is exactly what §6 asks about — "did the
   * session that produced this evidence write this criterion" — so a fixture that could not
   * rewrite anything could not pose the question at all. This helper therefore answers the
   * proposal it just filed, standing in for the owner: it reads the proposal's own one-time key
   * out of the table (the proposer never receives it, by construction) and posts it back with no
   * acting session, which is the only credential the door accepts.
   *
   * What that must NOT do is move the author. The version the owner approves was composed by the
   * session that asked for it, and permitting a change is not writing one — so both routes are
   * expected to record `actingSessionId`, and every assertion below is written against that one
   * answer rather than against which route the edit happened to take.
   */
  async function state(
    items: Array<{ id?: string; text: string; verificationMethod?: string }>,
    actingSessionId?: string,
  ): Promise<void> {
    const result = await projects.update(ownerId, projectId, {
      acceptanceCriteriaItems: items.map((item) => ({
        ...(item.id ? { id: item.id } : {}),
        text: item.text,
        verificationMethod: item.verificationMethod ?? METHOD,
      })),
    } as never, actingSessionId) as { acceptanceCriteriaHold?: HeldEdit };
    const held = result.acceptanceCriteriaHold;
    if (!held) return;

    const { rows: [proposal] } = await sql.query<{ commit_token: string }>(
      `SELECT "commit_token" FROM "project_ratified_action_intent" WHERE "id" = $1::uuid`,
      [held.intentId],
    );
    assert.ok(proposal, 'a held edit files a proposal row this test can answer');
    const decided = await projects.decideCriteriaChange(ownerId, projectId, held.intentId, {
      decision: 'APPROVE',
      commitToken: proposal.commit_token,
      // The seal the proposal was composed against, which is still the one that stands: nothing
      // has edited these criteria between the hold and this line.
      baseSeal: held.baselineSeal,
    } as never);
    assert.equal(decided.applied, true, 'the owner approved it, so the edit is in force');
  }

  /** The definitions as the database holds them, ordinal order. */
  async function definitions(project: string = projectId): Promise<Array<{
    definitionId: string; revision: number; text: string;
  }>> {
    const { rows } = await sql.query<{ id: string; revision: number; text: string }>(
      `SELECT "id", "revision", "text" FROM "project_acceptance_criterion_definition"
        WHERE "project_id" = $1::uuid ORDER BY "ordinal"`,
      [project],
    );
    return rows.map((row) => ({ definitionId: row.id, revision: row.revision, text: row.text }));
  }

  async function authorship(project: string = projectId): Promise<AuthorshipRow[]> {
    const { rows } = await sql.query<AuthorshipRow>(
      `SELECT "definition_id", "revision", "project_id", "owner_id",
              "authored_by_session_id", "authored_by_type"
         FROM "${TABLE}" WHERE "project_id" = $1::uuid
        ORDER BY "definition_id", "revision"`,
      [project],
    );
    return rows;
  }

  /** `(definitionId, revision) -> session`, the shape §6 will look a criterion up in. */
  const bySession = (rows: AuthorshipRow[]): Array<[string, number, string | null, string]> =>
    rows.map((row) => [
      row.definition_id, row.revision, row.authored_by_session_id, row.authored_by_type,
    ]);

  const sessionOne = await actingSession('the session that states the criteria');
  const sessionTwo = await actingSession('the session that rewrites one of them');
  const sessionThree = await actingSession('the session that only reorders them');

  // ═══ (a) the relation §6 reads, and the wall it deliberately did not go on ═════════════════════

  await t.test('(a) authorship is keyed by version, and the acceptance wall is untouched', async () => {
    const key = await sql.query<{ name: string }>(`
      SELECT a.attname AS name
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
       WHERE n.nspname = 'public' AND c.relname = $1 AND con.contype = 'p'
       ORDER BY k.ord`, [TABLE]);
    assert.deepEqual(key.rows.map((row) => row.name), ['definition_id', 'revision'],
      'one row per criterion VERSION is the whole shape; a per-criterion key cannot answer §6');

    // The census the three preserved-column suites run, run here too: a `project_acceptance_*`
    // relation must not have appeared, and the definition's own columns must be what they were.
    const wall = await sql.query<{ name: string; columns: string }>(`
      SELECT c.relname AS name,
             string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod)
                        || CASE WHEN a.attnotnull THEN '!' ELSE '' END, ', '
                        ORDER BY a.attnum) AS columns
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
       WHERE n.nspname = 'public' AND c.relkind = 'r'
         AND c.relname LIKE 'project\\_acceptance\\_%'
         AND a.attnum > 0 AND NOT a.attisdropped
       GROUP BY c.relname ORDER BY c.relname`);
    assert.deepEqual(
      Object.fromEntries(wall.rows.map((row) => [row.name, row.columns])),
      { project_acceptance_criterion_definition: DEFINITION_COLUMNS },
      'authorship must not have reached the acceptance wall — not as a table, not as a column');
    assert.ok(!TABLE.startsWith('project_acceptance_'),
      'the name itself has to stay off that prefix, which is what the census matches on');
  });

  // ═══ (1) the positive: stating a criterion from a session records THAT session ═════════════════

  await t.test('(1) a criterion authored from a session records it, exactly once', async () => {
    assert.deepEqual(await authorship(), [], 'the project starts with no criteria and no authors');

    await state([{ text: FIRST }, { text: SECOND }], sessionOne);

    const stated = await definitions();
    assert.deepEqual(stated.map((row) => row.revision), [1, 1],
      'two criteria, neither of them edited yet');

    const rows = await authorship();
    assert.equal(rows.length, 2, 'one authorship row per criterion version, and no more');
    assert.deepEqual(bySession(rows).map(([, revision, session, type]) => [revision, session, type]),
      [[1, sessionOne, 'AGENT'], [1, sessionOne, 'AGENT']],
      'the row names the session the write came from, not the owner behind it');
    assert.deepEqual(rows.map((row) => row.definition_id).sort(),
      stated.map((row) => row.definitionId).sort(),
      'and it names the definitions that were actually written');
    for (const row of rows) {
      assert.equal(row.project_id, projectId);
      assert.equal(row.owner_id, ownerId, 'the tenancy pair the FK is on');
    }
  });

  // ═══ (2) a rewrite is a new version, with an author of its own ═════════════════════════════════

  await t.test('(2) rewriting the text advances the revision and adds a SECOND row', async () => {
    const before = await authorship();
    assert.equal(before.length, 2, '(1) wrote the fixture this measures against');
    const [kept, reworded] = await definitions();

    // One criterion reworded from ANOTHER session; the other restated byte for byte.
    await state([
      { id: kept.definitionId, text: kept.text },
      { id: reworded.definitionId, text: REWORDED },
    ], sessionTwo);

    assert.deepEqual((await definitions()).map((row) => [row.definitionId, row.revision]),
      [[kept.definitionId, 1], [reworded.definitionId, 2]],
      'the database advanced exactly one revision — the trigger did, not the service');

    const after = await authorship();
    assert.equal(after.length, 3, 'the rewrite APPENDED a version; it did not rewrite the first');
    assert.deepEqual(
      after.filter((row) => row.definition_id === reworded.definitionId)
        .map((row) => [row.revision, row.authored_by_session_id]),
      [[1, sessionOne], [2, sessionTwo]],
      'both versions are on record, each naming the session that wrote THAT one');
    // The negative, measured in the same call that demonstrably added a row above: a criterion
    // that was restated unchanged gains nothing, and does not have its author moved to the
    // session that touched the collection.
    assert.deepEqual(
      after.filter((row) => row.definition_id === kept.definitionId)
        .map((row) => [row.revision, row.authored_by_session_id]),
      [[1, sessionOne]],
      'restating a criterion unchanged neither adds a version nor reassigns its author');
  });

  // ═══ (3) reordering is not authoring ═══════════════════════════════════════════════════════════

  await t.test('(3) moving a criterion up the list writes nothing', async () => {
    const before = await authorship();
    assert.equal(before.length, 3, '(2) wrote the fixture this measures against');
    const [head, tail] = await definitions();

    // BOTH ordinals move, and one of the two texts is rewritten, in a single call from a third
    // session. The rewrite is the positive control the reorder is measured against: if this call
    // wrote nothing at all, "reordering added no row" would be true of a table nothing can write.
    await state([
      { id: tail.definitionId, text: tail.text },
      { id: head.definitionId, text: 'the criterion that was moved AND rewritten' },
    ], sessionThree);

    assert.deepEqual((await definitions()).map((row) => [row.definitionId, row.revision]),
      [[tail.definitionId, 2], [head.definitionId, 2]],
      'both criteria changed position, and the rewritten one is now on its second version');

    const afterMixed = await authorship();
    assert.equal(afterMixed.length, 4, 'exactly one version was appended by that call');
    assert.deepEqual(
      afterMixed.filter((row) => row.definition_id === head.definitionId)
        .map((row) => [row.revision, row.authored_by_session_id]),
      [[1, sessionOne], [2, sessionThree]],
      'the rewrite inside that same call is on record — the positive half of this pair');
    assert.deepEqual(
      afterMixed.filter((row) => row.definition_id === tail.definitionId)
        .map((row) => [row.revision, row.authored_by_session_id]),
      [[1, sessionOne], [2, sessionTwo]],
      'the criterion whose ONLY change was its ordinal gained no version and kept both authors');

    // And now the pure reorder: the same collection, swapped back, byte for byte.
    const current = await definitions();
    await state([...current].reverse().map((row) => ({
      id: row.definitionId, text: row.text,
    })), sessionThree);

    assert.deepEqual((await definitions()).map((row) => row.revision), [2, 2],
      'a pure reorder advances no revision');
    assert.deepEqual(bySession(await authorship()), bySession(afterMixed),
      'a pure reorder adds no row and reassigns no author');
  });

  // ═══ (4) the rows that predate 0251: SYSTEM, and not a rewrite of what is known ════════════════

  await t.test('(4) the backfill says SYSTEM/NULL, and leaves a known author alone', async () => {
    const [known, orphaned] = await definitions();
    const authored = await authorship();
    assert.equal(authored.length, 4, '(3) left a fixture with four authored versions');

    // A criterion as it stood the moment before 0251 ran: no authorship row anywhere.
    await sql.query(`DELETE FROM "${TABLE}" WHERE "definition_id" = $1::uuid`,
      [orphaned.definitionId]);
    assert.equal((await authorship()).length, 2, 'one criterion now has no author at all');

    await sql.query(backfillStatement());

    const after = await authorship();
    const backfilled = after.filter((row) => row.definition_id === orphaned.definitionId);
    assert.deepEqual(backfilled.map((row) => [row.revision, row.authored_by_type,
      row.authored_by_session_id]), [[orphaned.revision, 'SYSTEM', null]],
      'the criterion nobody can attribute reads SYSTEM with no session, at its CURRENT revision');

    // The paired positive, in the same fixture and the same statement: a criterion whose author IS
    // known keeps every version and every session. Without it, "the backfill wrote SYSTEM" would
    // also pass for a backfill that overwrote the whole table with SYSTEM.
    assert.deepEqual(
      bySession(after.filter((row) => row.definition_id === known.definitionId)),
      bySession(authored.filter((row) => row.definition_id === known.definitionId)),
      'the backfill must not touch a version whose author is on record');

    // The timestamp it settles on, checked server-side so no client timezone can decide it.
    const { rows: [stamp] } = await sql.query<{ matches: boolean }>(
      `SELECT (a."authored_at" = d."updated_at" AT TIME ZONE 'UTC') AS matches
         FROM "${TABLE}" a JOIN "project_acceptance_criterion_definition" d ON d."id" = a."definition_id"
        WHERE a."definition_id" = $1::uuid AND a."revision" = $2::int`,
      [orphaned.definitionId, orphaned.revision]);
    assert.equal(stamp.matches, true,
      'a backfilled row is stamped with when that version was last written, read as UTC');
  });

  // ═══ (5) the owner channel is USER — which is neither AGENT nor SYSTEM ═════════════════════════

  await t.test('(5) a criterion written with no acting session is USER, not SYSTEM', async () => {
    const ownerProject = randomUUID();
    await prisma.project.create({
      data: { id: ownerProject, ownerId, title: 'The project the owner states criteria on' },
    });

    // `create`, with no coordinator seed: the owner-authenticated channel, which carries no
    // session context of any kind. The other call site of the same writer.
    const created = await projects.create(ownerId, {
      title: 'stated over the owner channel',
      acceptanceCriteriaItems: [{ text: FIRST, verificationMethod: METHOD }],
    } as never) as { id: string };
    assert.deepEqual((await authorship(created.id)).map((row) => [row.revision,
      row.authored_by_type, row.authored_by_session_id]), [[1, 'USER', null]],
      'criteria stated while the project is created are authored too');

    // And `update`, the other door, on a project of its own.
    await projects.update(ownerId, ownerProject, {
      acceptanceCriteriaItems: [{ text: SECOND, verificationMethod: METHOD }],
    } as never);

    const rows = await authorship(ownerProject);
    assert.deepEqual(rows.map((row) => [row.revision, row.authored_by_type,
      row.authored_by_session_id]), [[1, 'USER', null]],
      'the owner channel names no session, and says so as USER');

    // The distinction the gate depends on, asserted as one comparison: three writes, three answers.
    // Collapse USER into SYSTEM and every criterion older than 0251 becomes owner-written.
    const backfilled = (await authorship()).find((row) => row.authored_by_type === 'SYSTEM');
    const fromSession = (await authorship()).find((row) => row.authored_by_type === 'AGENT');
    assert.ok(backfilled, '(4) left a SYSTEM row in the fixture');
    assert.ok(fromSession, '(1) left an AGENT row in the fixture');
    assert.deepEqual(
      [fromSession.authored_by_session_id !== null, rows[0].authored_by_type,
        backfilled.authored_by_type],
      [true, 'USER', 'SYSTEM'],
      'authored by a session, authored by the owner, and authored by nobody-knows-who are three');
  });
});
