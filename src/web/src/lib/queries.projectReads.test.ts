import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectSessionsQuery } from './queries';

/**
 * A workspace list reads every project it shows, and those reads fall due together (on a page load,
 * on each shared interval, while the stream is down): forty-odd at once on a large account. They go
 * to the server a few at a time.
 */

const h = vi.hoisted(() => ({ out: [] as Array<{ path: string; answer: () => void }>, asked: 0 }));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn((path: string) => {
    h.asked += 1;
    return new Promise((resolve) => {
      const read = { path, answer: () => resolve([]) };
      h.out.push(read);
    });
  }),
}));

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  h.out = [];
  h.asked = 0;
});

describe('project reads', () => {
  it('go to the server four at a time however many fall due together', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const reads = Array.from({ length: 42 }, (_, i) =>
      client.fetchQuery(projectSessionsQuery({ projectId: `P${i}`, view: 'open' })));
    await settle();
    expect(h.out, 'every project was read at once').toHaveLength(4);

    let mostOut = h.out.length;
    while (h.out.length > 0) {
      h.out.shift()!.answer();
      await settle();
      mostOut = Math.max(mostOut, h.out.length);
    }
    await Promise.all(reads);
    expect(mostOut).toBeLessThanOrEqual(4);
    expect(h.asked, 'a project was not read').toBe(42);
  });

  it('still reads a project at once when nothing else is out', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const read = client.fetchQuery(projectSessionsQuery({ projectId: 'P1', view: 'open', includeLanding: true }));
    await settle();
    expect(h.out.map((r) => r.path)).toEqual(['/sessions?projectId=P1&view=open&includeLanding=1']);
    h.out.shift()!.answer();
    await expect(read).resolves.toEqual([]);
  });
});
