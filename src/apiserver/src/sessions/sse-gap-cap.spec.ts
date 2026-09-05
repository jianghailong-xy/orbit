import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY, firstValueFrom, take, toArray } from 'rxjs';
import { RunEventType } from '@orbit/shared';
import { SessionsController } from './sessions.controller';
import { MAX_IMAGE_PAYLOAD } from './truncate-payload';

/**
 * What a resuming client is allowed to be handed.
 *
 * The transcript stream's contract used to be "a cursor'd connect replays its whole gap, whatever
 * that costs", and the cost turned out to be unbounded in two directions at once. A turn that read
 * two screenshots put 580KB of base64 in a 130-event gap; every reconnect below it re-sent all of
 * it, and a client that couldn't commit the replay reconnected from the same cursor forever — 21
 * times over 20 minutes, in the incident this pins.
 *
 * So both bounds are asserted here: the byte one (an oversized image loses its data on the way
 * out) and the count one (a gap past SSE_GAP_CAP is refused in favour of a `resync`).
 */

const SESSION = '01a00b25-7e01-7b13-8319-804bce6e90dc';

/** Enough of a run_event row for the controller's map(). */
const row = (seq: number, payload: unknown = { text: 'hi' }, type = RunEventType.ASSISTANT) => ({
  seq,
  type: type as string,
  payload,
  turnId: null,
  createdAt: new Date('2026-08-16T16:00:00Z'),
});

/** The controller with just the two collaborators the SSE path touches. */
function controllerOver(rows: ReturnType<typeof row>[]): SessionsController {
  const prisma = {
    session: { findFirst: async () => ({ id: SESSION }) },
    $queryRaw: async () => rows,
  };
  // No live events: the test is about the replay half, and an endless live stream would hang it.
  const realtime = { streamForRun: () => EMPTY, turnPrefix: () => ({ text: '', thinking: '' }) };
  return new SessionsController({} as never, prisma as never, realtime as never, {} as never, {} as never);
}

const collect = async (c: SessionsController, sinceSeq: string, n: number): Promise<any[]> =>
  firstValueFrom(
    (c.events({ userId: 'u1' } as never, SESSION, sinceSeq, '2048') as any).pipe(take(n), toArray()),
  );

test('a gap within the cap replays every event', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => row(1341 + i));
  const out = await collect(controllerOver(rows), '1340', 3);
  assert.deepEqual(
    out.map((m) => m.data.seq),
    [1341, 1342, 1343],
  );
});

test('a gap past SSE_GAP_CAP is refused with a single resync, not a truncated replay', async () => {
  // The controller asks for one row past the cap purely to detect this; 1001 rows is what
  // "more than SSE_GAP_CAP" looks like coming back from that query.
  const rows = Array.from({ length: 1001 }, (_, i) => row(i + 1));
  const out = await collect(controllerOver(rows), '1', 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].data.type, RunEventType.RESYNC);
  // Seq 0 puts it alongside the approval nudges, which every client handles ahead of its seq
  // dedup — a resync that got deduped would strand the client it was meant to rescue.
  assert.equal(out[0].data.seq, 0);
});

test('an oversized image is stripped of its bytes on the way out', async () => {
  const data = 'x'.repeat(MAX_IMAGE_PAYLOAD + 1);
  const rows = [
    row(
      1341,
      { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] },
      RunEventType.TOOL_RESULT,
    ),
  ];
  const out = await collect(controllerOver(rows), '1340', 1);
  const block = out[0].data.payload.content[0];
  assert.equal(block.type, 'image');
  assert.equal('data' in block.source, false);
  // The flag is what tells the card to refetch itself whole from /events/:seq/full.
  assert.equal(out[0].data.truncated, true);
});

test('a small image still arrives inline, costing no refetch', async () => {
  const data = 'x'.repeat(1024);
  const rows = [
    row(1341, { content: [{ type: 'image', source: { media_type: 'image/png', data } }] }, RunEventType.TOOL_RESULT),
  ];
  const out = await collect(controllerOver(rows), '1340', 1);
  assert.equal(out[0].data.payload.content[0].source.data, data);
  assert.equal(out[0].data.truncated, undefined);
});
