import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamReport } from './listBudget';
import { watchesQuery } from './queries';

/**
 * A watch refresh is one request: the server answers the union the page needs
 * (`GET /watches?following=true`), and a component that mounts while the list is fresh reads nothing.
 */

const h = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(async (path: string) => {
    h.paths.push(path);
    return [];
  }),
}));

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  h.paths = [];
  streamReport.opened();
});
afterEach(() => streamReport.stopped());

describe('watchesQuery', () => {
  it('sends exactly one request for one refresh', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await client.fetchQuery(watchesQuery());
    expect(h.paths).toEqual(['/watches?following=true']);

    h.paths = [];
    await client.refetchQueries({ queryKey: ['watches'], type: 'all' });
    expect(h.paths).toEqual(['/watches?following=true']);
  });

  it('sends nothing for a component that mounts while the list is fresh', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await client.fetchQuery(watchesQuery());
    h.paths = [];

    const mounted = [1, 2, 3].map(() => new QueryObserver(client, watchesQuery()).subscribe(() => {}));
    await settle();
    expect(h.paths).toEqual([]);
    mounted.forEach((unsubscribe) => unsubscribe());
  });

  it('is read again by a mount once the stream is down', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await client.fetchQuery(watchesQuery());
    h.paths = [];

    streamReport.dropped();
    const unsubscribe = new QueryObserver(client, watchesQuery()).subscribe(() => {});
    await settle();
    expect(h.paths).toEqual(['/watches?following=true']);
    unsubscribe();
  });
});
