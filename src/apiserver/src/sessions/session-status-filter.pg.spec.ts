/**
 * `?status=` ON THE FACTS RETURNS THE ROWS IT RETURNED ON THE STORED WORD (task T10 of
 * docs/session-status-retirement-plan.md, §6), against PostgreSQL:
 *
 *   GET /sessions/compact?status= and the runner's GET /runner/sessions?status= both end in
 *   SessionsService.listForOrchestration, which used to filter `status = <word>` and now asks statusWordFilter(word).
 *   On a database seeded with a conversation of every row shape of session-legacy-words.fixture.ts, written as its
 *   facts (since deploy D3 nothing writes the word):
 *
 *   (1) for every word, the rows listed are the rows whose word a writer stored before deploy 3 is that word, except
 *       exactly the plan's §3.4 kinds (named in session-legacy-words.golden.json), which are listed under the word the
 *       projector gives them
 *   (2) for every held word the rows are the same as before
 *   (3) a word the protocol does not have, or one in another case, is ignored: the whole list, as before
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-status-filter.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';

import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { WORD_SHAPES } from './session-legacy-words.fixture';
import { SessionsService } from './sessions.service';
import { turnStateOfWord } from './session-turn-state';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const GOLDEN = path.resolve(__dirname, '../../../../src/apiserver/src/sessions/session-legacy-words.golden.json');
const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as {
  rows: Array<{ shape: string; stored: string; word: string; kind?: string }>;
};
const HELD_WORDS = ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'];

test('?status= lists the rows the stored word listed, but for the §3.4 kinds', { skip, timeout: 300_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const db = prismaClientFor(URL!);
  t.after(() => db.$disconnect());
  // listForOrchestration reads nothing but the database.
  const sessions = Object.create(SessionsService.prototype) as SessionsService;
  Object.assign(sessions, { prisma: db });

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `filter-${ownerId}@status-filter.invalid`, name: 'filter', passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'filter-runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  const workspace = await db.workspace.create({ data: { ownerId, runnerId, name: 'filter-workspace', enabled: true } });

  // The flat list shows conversations only, so the landing containers are left out of the seed.
  const conversations = WORD_SHAPES.filter((shape) => shape.facts.sessionKind === 'CONVERSATION');
  const title = new Map<string, string>();
  for (const shape of conversations) {
    const { turnState: _fromTheWord, ...facts } = shape.facts;
    // Its turn state is its stored word's; the release facts are the shape's.
    const { id } = await db.session.create({
      data: {
        ownerId, creatorId: ownerId, title: shape.name, prompt: 'filter', turnState: turnStateOfWord(shape.stored),
        dispatchOrigin: SessionDispatchOrigin.USER, provider: 'claude', providerBuiltin: true,
        workspaceId: workspace.id, assignedRunnerId: runnerId, ...facts,
      },
    });
    title.set(id, shape.name);
  }
  // listForOrchestration answers 100 rows at most: the seed must fit, or a word's rows could be cut short.
  assert.ok(title.size < 100, `${title.size} rows seeded`);

  /** The rows of the stored word, as the filter read them before: `status = <word>`, the word each shape's writer
   *  stored before deploy 3. */
  const before = async (word: string): Promise<string[]> =>
    conversations.filter((shape) => shape.stored === word).map((shape) => shape.name).sort();
  const listed = async (status?: string) => {
    const rows = await sessions.listForOrchestration(ownerId, { status });
    return rows.map((row) => ({ title: title.get(row.id) ?? row.id, status: row.status as string }));
  };
  const kindOf = new Map(golden.rows.filter((row) => row.kind).map((row) => [row.shape, row]));

  await t.test('(1) every word: the same rows as the stored word, but for the §3.4 kinds', async () => {
    const answers: Record<string, unknown> = {};
    const expected: Record<string, unknown> = {};
    for (const word of Object.values(RunStatus)) {
      const rows = await listed(word);
      // Every row listed for the word carries that word.
      assert.deepEqual(rows.filter((row) => row.status !== word), [], `${word}: a row listed under another word`);
      answers[word] = rows.map((row) => row.title).sort();
      const old = await before(word);
      // Before, less the §3.4 rows stored as this word, plus the §3.4 rows the projector gives this word.
      const kinds = [...kindOf.values()].filter((row) => conversations.some((shape) => shape.name === row.shape));
      expected[word] = [
        ...old.filter((name) => !kindOf.has(name)),
        ...kinds.filter((row) => row.word === word).map((row) => row.shape),
      ].sort();
    }
    assert.deepEqual(answers, expected);
    // The §3.4 kinds are present in the seed, so (1) compared them and did not just skip them.
    assert.ok([...kindOf.keys()].some((name) => conversations.some((shape) => shape.name === name)));
  });

  await t.test('(2) every held word: exactly the rows of before', async () => {
    const answers: Record<string, string[]> = {};
    const expected: Record<string, string[]> = {};
    for (const word of HELD_WORDS) {
      answers[word] = (await listed(word)).map((row) => row.title).sort();
      expected[word] = await before(word);
      assert.ok(expected[word].length > 0, `${word}: a row of the word is in the seed`);
    }
    assert.deepEqual(answers, expected);
  });

  await t.test('(3) an unknown word, or another case, is no filter', async () => {
    const all = (await listed()).map((row) => row.title).sort();
    assert.equal(all.length, title.size);
    for (const word of ['PARKED', 'pending', 'Running', '']) {
      assert.deepEqual((await listed(word)).map((row) => row.title).sort(), all, word);
    }
  });
});
