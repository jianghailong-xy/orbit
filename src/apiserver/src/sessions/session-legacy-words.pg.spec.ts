/**
 * THE SQL TWIN OF THE LEGACY STATUS WORD PROJECTOR, AND THE ?status= CONDITION, AGAINST POSTGRESQL (task T4 of
 * docs/session-status-retirement-plan.md, §3.1 and §6):
 *
 *   (1) session_legacy_status (migration 1621) answers what legacySessionStatus answers over every combination of
 *       the facts it reads, the landing's settlement among them
 *   (2) a session of every shape of session-legacy-words.fixture.ts, written to the database, derives from its stored
 *       columns the word the fixture's facts derive, in TypeScript and in SQL
 *   (3) statusWordFilter(word) selects exactly the conversation sessions the projector gives that word
 *   (4) a held row with no turn_state, as one not yet backfilled has, answers its stored word for every held word, in
 *       TypeScript, in SQL and on the payload fields
 *   (5) turnStateWhere (Prisma), sessionTurnStateSql (raw SQL) and sessionTurnState (TypeScript) select, for every set
 *       of turn states, exactly the rows the held words they replace selected: every shape above, the unfilled rows
 *       of (4) among them (task T8)
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-legacy-words.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Prisma, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus, SessionEndReason } from '@orbit/shared';

import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  type HeldTurnState,
  LEGACY_STATUS_SELECT,
  legacySessionStatus,
  sessionTurnState,
  sessionTurnStateSql,
  statusWordFilter,
  TURN_STATE_SELECT,
  turnStateWhere,
} from './session-legacy-words';
import { withSessionState } from './session-state';
import { WORD_SHAPES } from './session-legacy-words.fixture';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const AT = '2026-11-21T00:00:00';
const FINISHED = [null, AT];
const TURN_STATES = [null, 'QUEUED', 'IN_FLIGHT', 'ABANDONED'];
const END_REASONS = [null, '', ...Object.values(SessionEndReason), 'idle', 'orphaned'];
const OUTCOMES = [null, 'ANSWERED', 'FAILED', 'INTERRUPTED', 'CANCELLED'];
const STARTED = [null, AT];
const IMPORTS = [null, '/home/someone/project'];
const KINDS = ['CONVERSATION', 'LANDING'];
const WORDS = Object.values(RunStatus);
const HELD_WORDS = ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'] as const;
const SETTLED = [null, 'LANDED', 'ALREADY_LANDED', 'NOTHING_TO_LAND', 'MERGED', 'HANDLED', 'DECLINED', 'CANCELLED', 'DELETED'];

test('the projector, its SQL twin and statusWordFilter agree', { skip, timeout: 300_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const db = prismaClientFor(URL!);
  t.after(() => db.$disconnect());

  await t.test('(1) session_legacy_status over every combination of the facts', async () => {
    const combos = FINISHED.flatMap((finishedAt) => TURN_STATES.flatMap((turnState) => END_REASONS.flatMap(
      (endReason) => OUTCOMES.flatMap((lastTurnOutcome) => STARTED.flatMap((startedAt) => IMPORTS.flatMap(
        (importSourceCwd) => KINDS.flatMap((sessionKind) => SETTLED.map((settledAs) => ({
          finishedAt, turnState, endReason, lastTurnOutcome, startedAt, importSourceCwd, sessionKind, settledAs,
        })))))))))
      // The stored word beside them, each in turn (the cycle of seven shares no factor with the others' sizes).
      .map((combo, i) => ({ ...combo, status: WORDS[i % WORDS.length] as string }));
    const words = await db.$queryRawUnsafe<Array<{ word: string }>>(`
      SELECT session_legacy_status(c."finishedAt", c."turnState", c."endReason", c."lastTurnOutcome", c."startedAt",
                                   c."importSourceCwd", c."sessionKind", c."settledAs", c."status") AS word
        FROM jsonb_to_recordset($1::jsonb) AS c(
          "finishedAt" timestamp, "turnState" text, "endReason" text, "lastTurnOutcome" text, "startedAt" timestamp,
          "importSourceCwd" text, "sessionKind" text, "settledAs" text, "status" text)`, JSON.stringify(combos));
    assert.equal(words.length, combos.length);
    const differences = combos.flatMap((c, i) => {
      const word = legacySessionStatus(c, c.settledAs === null ? null : { settledAt: AT, settledAs: c.settledAs });
      return word === words[i].word ? [] : [`${JSON.stringify(c)}: TypeScript ${word}, SQL ${words[i].word}`];
    });
    assert.deepEqual(differences.slice(0, 10), [], `${differences.length} differences`);
  });

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `words-${ownerId}@legacy-words.invalid`, name: 'words', passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'words-runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  const workspace = await db.workspace.create({ data: { ownerId, runnerId, name: 'words-workspace', enabled: true } });
  const project = await db.project.create({ data: { ownerId, title: 'words project' } });
  const codebase = await db.projectCodebase.create({
    data: {
      ownerId, projectId: project.id, canonicalRepoUrl: `https://github.com/example/words-${project.id}`,
      upstreamRef: 'refs/heads/main', integrationRef: 'refs/heads/main', refAuthority: 'REMOTE',
    },
  });

  /** Session id by shape name. */
  const ids = new Map<string, string>();
  for (const shape of WORD_SHAPES) {
    const landing = shape.facts.sessionKind === 'LANDING';
    const task = landing
      ? await db.task.create({
        data: { ownerId, creatorType: 'USER', creatorId: ownerId, title: shape.name, projectId: project.id, completionCriterion: 'EVIDENCE_JUDGMENT' },
      })
      : null;
    const { turnState: _fromTheWord, status: _asStored, ...facts } = shape.facts;
    // Through the stored word alone for turn_state: the D1 trigger keeps it, as every writer today leaves it.
    const { id } = await db.session.create({
      data: {
        ownerId, creatorId: ownerId, title: shape.name, prompt: 'words', status: shape.stored,
        dispatchOrigin: SessionDispatchOrigin.USER,
        ...(landing
          ? { provider: 'orbit', providerBuiltin: true, startsTaskWork: false }
          : { provider: 'claude', providerBuiltin: true, workspaceId: workspace.id, assignedRunnerId: runnerId }),
        ...facts,
      },
    });
    if (task && shape.landing) {
      await db.projectLanding.create({
        data: {
          id: randomUUID(), projectId: project.id, ownerId, codebaseId: codebase.id, subject: 'TASK', taskId: task.id,
          sessionId: id, settledAt: new Date(), settledAs: shape.landing.settledAs,
        },
      });
    }
    ids.set(shape.name, id);
  }

  await t.test('(2) every row shape, from its stored columns, in TypeScript and SQL', async () => {
    const rows = await db.session.findMany({ where: { ownerId }, select: { id: true, ...LEGACY_STATUS_SELECT } });
    const sql = await db.$queryRawUnsafe<Array<{ id: string; word: string }>>(`
      SELECT s.id::text AS id, session_legacy_status(s.finished_at, s.turn_state, s.end_reason, s.last_turn_outcome,
               s.started_at, s.import_source_cwd, s.kind, l.settled_as, s.status::text) AS word
        FROM session s LEFT JOIN project_landing l ON l.session_id = s.id
       WHERE s.owner_id = $1::uuid`, ownerId);
    const stored = new Map(rows.map((row) => [row.id, row]));
    const words = new Map(sql.map((row) => [row.id, row.word]));
    for (const shape of WORD_SHAPES) {
      const id = ids.get(shape.name)!;
      const expected = legacySessionStatus(shape.facts, shape.landing);
      assert.equal(legacySessionStatus(stored.get(id)!, shape.landing), expected, `${shape.name}: stored columns`);
      assert.equal(words.get(id), expected, `${shape.name}: SQL`);
    }
  });

  await t.test('(3) statusWordFilter selects the conversations the projector gives each word', async () => {
    for (const word of Object.values(RunStatus)) {
      const found = await db.session.findMany({
        where: { AND: [{ ownerId }, statusWordFilter(word)!] }, select: { title: true },
      });
      const expected = WORD_SHAPES
        .filter((shape) => shape.facts.sessionKind === 'CONVERSATION' && legacySessionStatus(shape.facts, shape.landing) === word)
        .map((shape) => shape.name);
      assert.deepEqual(found.map((row) => row.title).sort(), expected.sort(), word);
      assert.ok(expected.length > 0, `no shape reads ${word}`);
    }
  });

  await t.test('(4) a held row with no turn_state answers its stored word', async () => {
    // Compared all at once, so a failure shows every word that is answered wrong.
    const answers: Record<string, unknown> = {};
    for (const word of HELD_WORDS) {
      const { id } = await db.session.create({
        data: {
          ownerId, creatorId: ownerId, title: `unfilled ${word}`, prompt: 'words', status: word,
          dispatchOrigin: SessionDispatchOrigin.USER, provider: 'claude', providerBuiltin: true,
          workspaceId: workspace.id, assignedRunnerId: runnerId, startedAt: new Date(),
        },
      });
      // As a row nothing has written since migration 1611: the word trigger fires on `status` alone.
      await db.$executeRawUnsafe('UPDATE session SET turn_state = NULL WHERE id = $1::uuid', id);
      const row = await db.session.findUniqueOrThrow({
        where: { id }, select: { ...LEGACY_STATUS_SELECT, completedAt: true, archivedAt: true, deletedAt: true },
      });
      assert.equal(row.turnState, null, word);
      const [sql] = await db.$queryRawUnsafe<Array<{ word: string }>>(`
        SELECT session_legacy_status(finished_at, turn_state, end_reason, last_turn_outcome, started_at,
                 import_source_cwd, kind, NULL, status::text) AS word
          FROM session WHERE id = $1::uuid`, id);
      const payload = withSessionState(row);
      answers[word] = { typescript: legacySessionStatus(row), sql: sql.word, status: payload.status, runStatus: payload.runStatus };
    }
    assert.deepEqual(answers, Object.fromEntries(HELD_WORDS.map((word) =>
      [word, { typescript: word, sql: word, status: word, runStatus: word }])));
  });

  await t.test('(5) the turn-state conditions select the rows the held words selected', async () => {
    const STATES: Array<HeldTurnState | null> = ['QUEUED', 'IN_FLIGHT', 'ABANDONED', null];
    const WORD_OF = new Map<HeldTurnState | null, string>([
      ['QUEUED', 'PENDING'], ['IN_FLIGHT', 'RUNNING'], ['ABANDONED', 'INTERRUPTED'], [null, 'AWAITING_INPUT'],
    ]);
    const rows = await db.session.findMany({ where: { ownerId }, select: { id: true, title: true, ...TURN_STATE_SELECT } });
    assert.ok(rows.some((row) => row.finishedAt == null && row.turnState == null && row.status !== 'AWAITING_INPUT'),
      'no unfilled held row to read');
    const titles = (ids: Iterable<string>) => rows.filter((row) => new Set(ids).has(row.id)).map((row) => row.title).sort();
    const results: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (let mask = 1; mask < 1 << STATES.length; mask += 1) {
      const states = STATES.filter((_, i) => mask & (1 << i));
      const words = states.map((state) => WORD_OF.get(state)!);
      const label = states.map((state) => state ?? 'none').join('+');
      // What the readers asked before: a held word of the set, read off the stored column.
      const before = rows.filter((row) => row.finishedAt == null && words.includes(row.status)).map((row) => row.id);
      const prisma = await db.session.findMany({ where: { AND: [{ ownerId }, turnStateWhere(...states)] }, select: { id: true } });
      const sql = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT s.id::text AS id FROM "session" s
         WHERE s."owner_id" = ${ownerId}::uuid AND ${sessionTurnStateSql('s', ...states)}`);
      const typescript = rows.filter((row) => row.finishedAt == null && states.includes(sessionTurnState(row)));
      results[label] = {
        prisma: titles(prisma.map((row) => row.id)), sql: titles(sql.map((row) => row.id)),
        typescript: titles(typescript.map((row) => row.id)),
      };
      expected[label] = { prisma: titles(before), sql: titles(before), typescript: titles(before) };
      if (states.length === 1) assert.ok(before.length >= 2, `${label}: no filled and unfilled rows to tell apart`);
    }
    assert.deepEqual(results, expected);
  });
});
