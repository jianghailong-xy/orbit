import { afterEach, describe, expect, it } from 'vitest';
import { applyOpenListDelta, forgetOpenListCursors, readOpenList, type OpenListAnswer, type OpenListDelta } from './openListDelta';

/**
 * The Open list read as a delta against the copy last read (docs/list-freshness-design.md §3): what
 * comes out has to be the list a whole read returns, whatever moved between two reads.
 */

interface Row {
  id: string;
  title: string;
  status: string;
}

/** The server's side, as apiserver's OpenListDeltaStore answers it: a snapshot per cursor of each
 *  row's content and the order; a delta names the rows whose content moved, the ids that left, and
 *  the whole order only when it moved. */
class FakeServer {
  list: Row[] = [];
  private snapshots = new Map<string, { order: string[]; rows: Map<string, string> }>();
  private next = 0;
  asked: string[] = [];

  answer(since: string): OpenListAnswer<Row> {
    this.asked.push(since);
    const order = this.list.map((row) => row.id);
    const rows = new Map(this.list.map((row) => [row.id, JSON.stringify(row)]));
    const cursor = `c${(this.next += 1)}`;
    const held = this.snapshots.get(since);
    this.snapshots.set(cursor, { order, rows });
    if (!held) return { full: true, sessions: structuredClone(this.list), cursor };
    const upserts = this.list.filter((row) => held.rows.get(row.id) !== rows.get(row.id));
    const removedIds = held.order.filter((id) => !rows.has(id));
    const delta: OpenListDelta<Row> = { full: false, upserts: structuredClone(upserts), removedIds, cursor };
    if (held.order.join() !== order.join()) delta.order = order;
    return delta;
  }
}

/** A small seeded generator, so a failure names the case it failed on. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** One random step: rows added, removed, edited and moved, any of them or none. */
function change(list: Row[], random: () => number, serial: { n: number }): Row[] {
  let next = list.map((row) => ({ ...row }));
  const pick = (): number => Math.floor(random() * next.length);
  if (random() < 0.4) {
    for (let i = Math.floor(random() * 3); i >= 0; i -= 1) {
      next.splice(Math.floor(random() * (next.length + 1)), 0, { id: `s${(serial.n += 1)}`, title: 'new', status: 'IDLE' });
    }
  }
  if (random() < 0.3 && next.length > 0) next.splice(pick(), 1);
  if (random() < 0.5 && next.length > 0) next[pick()].status = random() < 0.5 ? 'RUNNING' : 'IDLE';
  if (random() < 0.3 && next.length > 0) next[pick()].title = `t${Math.floor(random() * 1000)}`;
  if (random() < 0.3 && next.length > 1) {
    const [moved] = next.splice(pick(), 1);
    next.splice(pick(), 0, moved);
  }
  if (random() < 0.05) next = [];
  return next;
}

afterEach(() => forgetOpenListCursors());

describe('the Open list read as a delta', () => {
  it('reads what a whole read reads, over random adds, removes, edits and moves', async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      forgetOpenListCursors();
      const random = rng(seed);
      const serial = { n: 0 };
      const server = new FakeServer();
      server.list = change([], random, serial);
      for (let step = 0; step < 30; step += 1) {
        const read = await readOpenList('scope', async (since) => server.answer(since));
        expect(read, `seed ${seed}, step ${step}`).toEqual(server.list);
        server.list = change(server.list, random, serial);
      }
      // Every read after the first was a delta against the cursor before it, not a whole read.
      expect(server.asked.filter((since) => since === '').length, `seed ${seed}`).toBe(1);
    }
  });

  it('answers an empty delta with the very rows the last read returned', async () => {
    const server = new FakeServer();
    server.list = [{ id: 'a', title: 'A', status: 'IDLE' }, { id: 'b', title: 'B', status: 'RUNNING' }];
    const first = await readOpenList('scope', async (since) => server.answer(since));
    const second = await readOpenList('scope', async (since) => server.answer(since));
    expect(second).toHaveLength(2);
    second.forEach((row, i) => expect(row).toBe(first[i]));
  });

  it('applies a delta to the list the server sent, not to a copy edited since', async () => {
    const server = new FakeServer();
    server.list = [{ id: 'a', title: 'A', status: 'IDLE' }, { id: 'b', title: 'B', status: 'IDLE' }];
    const first = await readOpenList('scope', async (since) => server.answer(since));
    // The screen's copy is edited in place (an optimistic rename) the server then turns down.
    first[0] = { ...first[0], title: 'renamed here' };
    server.list = [{ id: 'a', title: 'A', status: 'IDLE' }, { id: 'b', title: 'B', status: 'RUNNING' }];
    const read = await readOpenList('scope', async (since) => server.answer(since));
    expect(read).toEqual(server.list);
  });

  it('replaces the list when the server answers it whole', async () => {
    const server = new FakeServer();
    server.list = [{ id: 'a', title: 'A', status: 'IDLE' }];
    await readOpenList('scope', async (since) => server.answer(since));
    const read = await readOpenList('scope', async () => ({
      full: true,
      sessions: [{ id: 'z', title: 'Z', status: 'IDLE' }],
      cursor: 'fresh',
    }));
    expect(read).toEqual([{ id: 'z', title: 'Z', status: 'IDLE' }]);
    const asked: string[] = [];
    await readOpenList('scope', async (since) => {
      asked.push(since);
      return { full: false, upserts: [], removedIds: [], cursor: since };
    });
    expect(asked).toEqual(['fresh']);
  });

  it('reads the list whole when a delta does not fit what it holds', async () => {
    const base = [{ id: 'a', title: 'A', status: 'IDLE' }];
    expect(applyOpenListDelta(base, { full: false, upserts: [], removedIds: [], order: ['a', 'ghost'], cursor: 'x' })).toBeNull();
    expect(applyOpenListDelta(base, {
      full: false, upserts: [{ id: 'new', title: 'N', status: 'IDLE' }], removedIds: [], cursor: 'x',
    })).toBeNull();

    const server = new FakeServer();
    server.list = base;
    await readOpenList('scope', async (since) => server.answer(since));
    const asked: string[] = [];
    const read = await readOpenList('scope', async (since) => {
      asked.push(since);
      if (since !== '') return { full: false, upserts: [], removedIds: [], order: ['a', 'ghost'], cursor: 'bad' };
      return { full: true, sessions: [{ id: 'b', title: 'B', status: 'IDLE' }], cursor: 'whole' };
    });
    expect(asked).toEqual(['c1', '']);
    expect(read).toEqual([{ id: 'b', title: 'B', status: 'IDLE' }]);
  });

  it('takes the plain array from a server that predates the delta read', async () => {
    const rows = [{ id: 'a', title: 'A', status: 'IDLE' }];
    const asked: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      await expect(readOpenList('scope', async (since) => {
        asked.push(since);
        return rows;
      })).resolves.toBe(rows);
    }
    expect(asked).toEqual(['', '']);
  });

  it('keeps one cursor per scope', async () => {
    const one = new FakeServer();
    const two = new FakeServer();
    one.list = [{ id: 'a', title: 'A', status: 'IDLE' }];
    two.list = [{ id: 'b', title: 'B', status: 'IDLE' }];
    await readOpenList('one', async (since) => one.answer(since));
    await readOpenList('two', async (since) => two.answer(since));
    two.list = [];
    await expect(readOpenList('one', async (since) => one.answer(since))).resolves.toEqual(one.list);
    await expect(readOpenList('two', async (since) => two.answer(since))).resolves.toEqual([]);
    expect(one.asked).toEqual(['', 'c1']);
    expect(two.asked).toEqual(['', 'c1']);
  });
});
