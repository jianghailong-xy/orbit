import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY, firstValueFrom, take, toArray } from 'rxjs';
import { RunEventType } from '@orbit/shared';
import { SessionsController } from './sessions.controller';
import { renderRawQuery } from '../test-support/prisma-transaction-double';

/**
 * Settings › Translation: a reply's translation reaches a client once, as a live-only `translation`
 * event some seconds after the reply. A phone whose socket was suspended at that moment resumed
 * after the reply's seq and never heard of it, so the reply kept "Translates when the reply is
 * done" for good (production session 34xw3JGbJhFUaOdGlT8Ix, seq 44, 2026-11-15). A cursor'd
 * connect now sends the newest translations behind its cursor again, after the gap.
 */

const SESSION = '01a00b25-7e01-7b13-8319-804bce6e90dc';

const gapRow = (seq: number) => ({
  seq,
  type: RunEventType.ASSISTANT as string,
  payload: { text: 'hi' },
  turnId: null,
  createdAt: new Date('2026-11-15T09:17:43Z'),
});

/** The rows the translation read returns: newest first, as its ORDER BY asks. */
const TRANSLATED = [
  { seq: 44, translation: { lang: 'zh-Hans', text: '中文' }, turnId: 't2' },
  { seq: 25, translation: { lang: 'zh-Hans', failed: true }, turnId: 't1' },
];

function controllerOver(gap: unknown[], translated: unknown[] | Error): { c: SessionsController; queries: string[] } {
  const queries: string[] = [];
  const prisma = {
    session: { findFirst: async () => ({ id: SESSION }) },
    $queryRaw: async (...args: unknown[]) => {
      const sql = renderRawQuery(args).text;
      queries.push(sql);
      if (!sql.includes("payload->'translation'")) return gap;
      if (translated instanceof Error) throw translated;
      return translated;
    },
  };
  const realtime = { streamForRun: () => EMPTY, turnPrefix: () => ({ text: '', thinking: '' }) };
  const c = new SessionsController({} as never, prisma as never, realtime as never, {} as never, {} as never, {} as never);
  return { c, queries };
}

const collect = async (c: SessionsController, sinceSeq: string | undefined, n: number): Promise<any[]> =>
  firstValueFrom((c.events({ userId: 'u1' } as never, SESSION, sinceSeq, '2048') as any).pipe(take(n), toArray()));

test('a cursor\'d connect sends the translations behind its cursor again, after the gap, oldest first', async () => {
  const { c } = controllerOver([gapRow(51), gapRow(52)], TRANSLATED);
  const out = await collect(c, '50', 4);
  assert.deepEqual(out.map((m) => [m.data.seq, m.data.type]), [
    [51, RunEventType.ASSISTANT],
    [52, RunEventType.ASSISTANT],
    [0, RunEventType.TRANSLATION],
    [0, RunEventType.TRANSLATION],
  ]);
  // The live event's own shape, so every client folds it into the reply it already holds.
  assert.deepEqual(out[2].data.payload, { of: 25, lang: 'zh-Hans', failed: true });
  assert.deepEqual(out[3].data.payload, { of: 44, lang: 'zh-Hans', text: '中文' });
  assert.equal(out[3].data.turnId, 't2');
});

test('the read is bounded behind the cursor and to replies and suggestions', async () => {
  const { c, queries } = controllerOver([gapRow(51)], []);
  await collect(c, '50', 1);
  const sql = queries.find((q) => q.includes("payload->'translation'"));
  assert.ok(sql, 'the translation read ran');
  assert.match(sql, /seq <= \? AND seq > \?/);
  assert.match(sql, /type IN \(\?, \?\)/);
  assert.match(sql, /LIMIT \?/);
});

test('a cursor-less connect does not read translations: its replay already carries them in the payloads', async () => {
  const { c, queries } = controllerOver([gapRow(1)], TRANSLATED);
  const out = await collect(c, undefined, 1);
  assert.equal(out[0].data.seq, 1);
  assert.equal(queries.some((q) => q.includes("payload->'translation'")), false);
});

test('a gap past the cap still answers with one resync and nothing else', async () => {
  const rows = Array.from({ length: 1001 }, (_, i) => gapRow(i + 2));
  const { c, queries } = controllerOver(rows, TRANSLATED);
  const out = await collect(c, '1', 1);
  assert.equal(out[0].data.type, RunEventType.RESYNC);
  assert.equal(queries.some((q) => q.includes("payload->'translation'")), false);
});

test('a failed translation read leaves the replay whole', async () => {
  const { c } = controllerOver([gapRow(51)], new Error('db down'));
  const out = await collect(c, '50', 1);
  assert.equal(out[0].data.seq, 51);
});
