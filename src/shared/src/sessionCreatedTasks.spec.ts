import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// Through the package's own entry: what the clients import is the thing under test.
import { createdTasksCountLine, SESSION_CREATED_TASKS_COPY, sessionTaskCard } from './index';

/**
 * `session-created-tasks.fixture.json` is the contract the web and the native client are both
 * proved against. This proves the fixture and the shared implementation agree, case by case.
 */
interface CountLineCase {
  running: number;
  failed: number;
  done: number;
  total: number;
  text: string;
}

interface CardCase {
  name: string;
  created: {
    running: number;
    failed: number;
    done: number;
    total: number;
    items: { id: string; status: string; running: boolean; queued: boolean; replaces: string | null }[];
  } | null;
  watched: { id: string; status: string | null; running: boolean; queued: boolean; stale: boolean }[];
  card: {
    rows: { id: string; watched: boolean; stale: boolean; elsewhere: boolean }[];
    counts: { running: number; failed: number; done: number; total: number };
    watching: number;
    stale: boolean;
  } | null;
}

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, 'session-created-tasks.fixture.json'), 'utf8'),
) as { copy: Record<string, string>; singleNamesTheTask: boolean; countLine: CountLineCase[]; card: CardCase[] };

describe('session-created-tasks.fixture.json', () => {
  it('every countLine case is exactly what createdTasksCountLine writes', () => {
    expect(fixture.countLine.length).toBeGreaterThan(0);
    for (const { text, ...counts } of fixture.countLine) {
      expect(createdTasksCountLine(counts), JSON.stringify(counts)).toBe(text);
    }
  });

  it('keeps the cases the row was designed around', () => {
    const texts = new Map(
      fixture.countLine.map(({ running, failed, done, total, text }) => [
        `${running},${failed},${done},${total}`,
        text,
      ]),
    );
    expect(texts.get('2,1,4,8')).toBe('2 running · 1 failed · 4/8 done');
    expect(texts.get('0,0,8,8')).toBe('8/8 done');
    expect(texts.get('0,1,0,3')).toBe('1 failed · 0/3 done');
    expect(texts.get('3,0,0,3')).toBe('3 running · 0/3 done');
    expect(texts.get('1,0,1,2')).toBe('1 running · 1/2 done');
  });

  it('describes counts a response can actually hold', () => {
    for (const { running, failed, done, total } of fixture.countLine) {
      const counts = JSON.stringify({ running, failed, done, total });
      for (const n of [running, failed, done, total]) expect(Number.isInteger(n) && n >= 0, counts).toBe(true);
      // A row is either DONE or FAILED, never both; a running row may carry either status.
      expect(failed + done, counts).toBeLessThanOrEqual(total);
      expect(running, counts).toBeLessThanOrEqual(total);
      // One row names its task instead of writing a sentence, and none means no row at all, so
      // neither has a sentence to pin here.
      expect(total, counts).toBeGreaterThan(1);
    }
  });

  it('has one set of words: the copy the web renders is the copy in the fixture', () => {
    expect(fixture.copy).toEqual(SESSION_CREATED_TASKS_COPY);
    expect(fixture.copy).toEqual({
      title: 'Tasks',
      viewAll: 'View all in Tasks ›',
      openProject: 'Open project ›',
      replacesPrefix: 'Replaces ',
      createdInChip: 'Created in ',
      elsewhere: 'elsewhere',
    });
  });

  it('a single row names its task instead of counting it', () => {
    expect(fixture.singleNamesTheTask).toBe(true);
  });

  it('every card case is exactly what sessionTaskCard draws', () => {
    expect(fixture.card.length).toBeGreaterThan(0);
    for (const c of fixture.card) {
      const created = c.created && {
        ...c.created,
        projects: [],
        items: c.created.items.map((item) => ({
          ...item,
          status: item.status as 'OPEN',
          title: `Task ${item.id}`,
          createdAt: '2026-10-07T00:00:00.000Z',
          projectId: null,
          replaces: item.replaces ? { id: item.replaces, title: `Task ${item.replaces}` } : null,
        })),
      };
      const watched = c.watched.map(({ id, status, running, queued, stale }) => ({
        id,
        title: `Task ${id}`,
        standing: status === null ? null : { status, running, queued },
        stale,
      }));
      const card = sessionTaskCard(created, watched);
      expect(
        card && {
          rows: card.rows.map((row) => ({
            id: row.id,
            watched: row.watched,
            stale: row.stale,
            elsewhere: row.createdAt === null,
          })),
          counts: card.counts,
          watching: card.watching,
          stale: card.stale,
        },
        c.name,
      ).toEqual(c.card);
    }
  });
});
